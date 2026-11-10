package app.gongxingji.training.debug;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.util.LinkedHashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Semaphore;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ScheduledFuture;

/** One current OTP intent; at most two tasks including retired, stuck I/O. */
final class PhoneOtpRequestLane {
    private static final String URL="https://service-1.example.invalid/api/auth/native-session/phone-otp";
    private static final long TOTAL_MILLIS=43000;
    private static final int RECENT_IDS=128;
    private static final long RECENT_NANOS=TimeUnit.MINUTES.toNanos(2);
    private static Thread daemon(Runnable r,String name){Thread t=new Thread(r,name);t.setDaemon(true);return t;}
    // Process-wide capacities also cover Activity recreation while old I/O hangs.
    private static final ThreadPoolExecutor worker=new ThreadPoolExecutor(0,2,30L,TimeUnit.SECONDS,new SynchronousQueue<Runnable>(),r->daemon(r,"phone-otp-request"),new ThreadPoolExecutor.AbortPolicy());
    private static final ThreadPoolExecutor cleanup=new ThreadPoolExecutor(2,2,30L,TimeUnit.SECONDS,new ArrayBlockingQueue<Runnable>(2),r->daemon(r,"phone-otp-close"),new ThreadPoolExecutor.AbortPolicy());
    // Count business I/O AND cleanup that has not terminated across Activities.
    private static final Semaphore resources=new Semaphore(2);
    private static final ScheduledThreadPoolExecutor deadlines=new ScheduledThreadPoolExecutor(1,r->daemon(r,"phone-otp-deadline"));
    static {deadlines.setRemoveOnCancelPolicy(true);cleanup.allowCoreThreadTimeOut(true);}
    // Completed local waits only: bounded recent duplicate suppression, not
    // durable server idempotency. Running/retired records are never evicted.
    private final LinkedHashMap<String,Long> seen=new LinkedHashMap<>();
    private final LinkedHashMap<Long,Request> running=new LinkedHashMap<>();
    private final ThreadLocal<Request> current=new ThreadLocal<>();
    private final long totalMillis;
    private Request active;
    private boolean closed;
    private long generation;

    static final class Request {
        final String id;final long generation,deadline;final Runnable onExpired;
        Thread thread;HttpURLConnection connection;ScheduledFuture<?> timer;
        boolean retired,finished,cleanupStarted,cleanupTerminated,cleanupFailed,resourceReleased;
        Request(String id,long generation,long deadline,Runnable onExpired){this.id=id;this.generation=generation;this.deadline=deadline;this.onExpired=onExpired;}
    }
    PhoneOtpRequestLane(){this(TOTAL_MILLIS);}
    PhoneOtpRequestLane(long millis){if(millis<1||millis>TOTAL_MILLIS)throw new IllegalArgumentException();totalMillis=millis;}
    static boolean matches(String url,String method){return "POST".equals(method)&&URL.equals(url);}
    static int readTimeoutMillis(String url,String method){return matches(url,method)?50000:15000;}
    enum Submission { ACCEPTED, DUPLICATE, REJECTED }
    Submission submit(String id,Runnable task){return submit(id,task,()->{});}

    private void pruneRecent(long now){
        Iterator<Map.Entry<String,Long>> entries=seen.entrySet().iterator();
        while(entries.hasNext())if(now-entries.next().getValue()>=RECENT_NANOS)entries.remove();
    }
    private void rememberCompleted(Request request){
        long now=System.nanoTime();pruneRecent(now);
        if(seen.size()>=RECENT_IDS)seen.remove(seen.keySet().iterator().next());
        seen.put(request.id,now);
    }

    synchronized Submission submit(String id,Runnable task,Runnable onExpired){
        if(id==null||id.length()==0||id.length()>128||task==null||onExpired==null)return Submission.REJECTED;
        for(Request request:running.values())if(id.equals(request.id))return Submission.DUPLICATE;
        pruneRecent(System.nanoTime());
        if(seen.containsKey(id))return Submission.DUPLICATE;
        // Capacity applies to live resources, never to completed ID history.
        // At resource capacity keep unknown; nothing is queued or retried.
        if(closed||active!=null||running.size()>=2||!resources.tryAcquire())return Submission.REJECTED;
        Request request=new Request(id,++generation,System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(totalMillis),onExpired);
        active=request;running.put(request.generation,request);
        try{
            request.timer=deadlines.schedule(()->expire(request),totalMillis,TimeUnit.MILLISECONDS);
            worker.execute(()->{
                current.set(request);synchronized(this){request.thread=Thread.currentThread();}
                try{task.run();}finally{
                    synchronized(this){request.finished=true;request.thread=null;if(request.timer!=null)request.timer.cancel(false);rememberCompleted(request);running.remove(request.generation);if(active==request)active=null;}
                    closeLater(request);
                    synchronized(this){releaseResource(request);}
                    current.remove();
                }
            });
            return Submission.ACCEPTED;
        }catch(RuntimeException unavailable){if(request.timer!=null)request.timer.cancel(false);request.finished=true;running.remove(request.generation);if(active==request)active=null;releaseResource(request);return Submission.REJECTED;}
    }
    private void releaseResource(Request request){
        if(request.finished&&(request.connection==null||request.cleanupTerminated)&&!request.resourceReleased){request.resourceReleased=true;resources.release();}
    }
    private void closeLater(Request request){
        final HttpURLConnection connection;
        synchronized(this){
            if(request.cleanupStarted||request.connection==null)return;
            connection=request.connection;request.cleanupStarted=true;
        }
        try{cleanup.execute(()->{
            try{
                connection.disconnect();
                synchronized(this){request.connection=null;}
            }catch(RuntimeException ignored){
                synchronized(this){request.cleanupFailed=true;}
                // The close attempt failed; never retry or claim the socket closed.
            }finally{
                synchronized(this){request.cleanupTerminated=true;releaseResource(request);}
            }
        });}catch(RuntimeException unavailable){
            synchronized(this){request.cleanupStarted=false;}
            // No false cleanup: keep the connection and resource reservation.
        }
    }
    void finishConnection(HttpURLConnection connection){
        Request request=current.get();
        if(request==null)throw new IllegalStateException("SMS request context missing");
        synchronized(this){
            // openConnection may return after retirement, before registration.
            if(connection!=null&&!request.cleanupStarted){
                if(request.connection!=null&&request.connection!=connection)throw new IllegalStateException("SMS connection mismatch");
                request.connection=connection;
            }
        }
        closeLater(request);
    }
    private void expire(Request request){
        synchronized(this){
            if(closed||request.finished||request.retired||running.get(request.generation)!=request)return;
            request.retired=true;if(active==request)active=null;
            if(request.thread!=null)request.thread.interrupt();
        }
        // Disconnect may itself block, so it cannot occupy the deadline thread.
        closeLater(request);
        try{request.onExpired.run();}catch(RuntimeException ignored){}
    }
    synchronized Request currentRequest(){return current.get();}
    synchronized boolean canDeliver(Request request){return request!=null&&!closed&&!request.retired&&request.generation==generation;}
    synchronized int remainingMillis()throws IOException{
        Request request=current.get();long left=request==null?0:request.deadline-System.nanoTime();
        if(closed||request==null||request.retired||request.finished||active!=request||request.thread!=Thread.currentThread()||left<=0||Thread.currentThread().isInterrupted())throw new IOException("短信请求等待已结束，发送结果未确认");
        return (int)Math.max(1,TimeUnit.NANOSECONDS.toMillis(left));
    }
    synchronized void checkActive()throws IOException{remainingMillis();}
    synchronized boolean connectionOpened(HttpURLConnection connection){
        try{checkActive();}catch(IOException expired){return false;}
        if(connection==null)return false;current.get().connection=connection;return true;
    }
    void connectionClosed(HttpURLConnection connection){finishConnection(connection);}
    void close(){
        synchronized(this){closed=true;active=null;for(Request request:running.values()){request.retired=true;if(request.timer!=null)request.timer.cancel(false);if(request.thread!=null)request.thread.interrupt();closeLater(request);}}
        // Shared executors outlive this Activity; never interrupt another lane.
    }
}
