package app.gongxingji.training.debug;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/** Exact behavioral port of photo-assist/decoder.ts; no Android or ORT dependency. */
final class NativePhotoDecoder {
    static final class Peak {
        final int x, y;
        final float response;
        Peak(int x, int y, float response) { this.x=x; this.y=y; this.response=response; }
    }
    static float sigmoid(float logit) {
        // JS evaluates in double and stores into Float32Array before decoding.
        return (float)(1.0 / (1.0 + Math.exp(-(double)logit)));
    }
    static List<Peak> decode(float[] probability, int width, int height) {
        if(probability==null || width<1 || height<1 || (long)width*height!=probability.length)
            throw new IllegalArgumentException("PHOTO_DIMENSIONS");
        int count=0;
        for(float v:probability) {
            if(Float.isNaN(v)||Float.isInfinite(v)) throw new IllegalArgumentException("PHOTO_NONFINITE");
            if(v>=.5f) count++;
        }
        if(count>50000) throw new IllegalArgumentException("PHOTO_DENSE");
        boolean[] seen=new boolean[probability.length];
        int[] frontier=new int[Math.max(1,count)];
        List<Peak> maxima=new ArrayList<>();
        for(int index=0;index<probability.length;index++) {
            float score=probability[index];
            if(score<.5f||seen[index]) continue;
            int representative=index, length=1; boolean maximum=true;
            frontier[0]=index; seen[index]=true;
            while(length>0) {
                int i=frontier[--length], y=i/width, x=i%width;
                representative=Math.min(representative,i);
                for(int ny=Math.max(0,y-1);ny<Math.min(height,y+2);ny++)
                    for(int nx=Math.max(0,x-1);nx<Math.min(width,x+2);nx++) {
                        int j=ny*width+nx; float v=probability[j];
                        if(v>score) maximum=false;
                        else if(v==score&&!seen[j]) { seen[j]=true; frontier[length++]=j; }
                    }
            }
            if(maximum) maxima.add(new Peak(representative%width,representative/width,score));
        }
        maxima.sort(Comparator.<Peak>comparingDouble(p->-p.response).thenComparingInt(p->p.y).thenComparingInt(p->p.x));
        List<Peak> kept=new ArrayList<>();
        for(Peak p:maxima) {
            boolean clear=true;
            for(Peak q:kept) { long dx=p.x-q.x,dy=p.y-q.y; if(dx*dx+dy*dy<=9) {clear=false;break;} }
            if(clear) {kept.add(p);if(kept.size()>256)throw new IllegalArgumentException("PHOTO_PEAK_OVERFLOW");}
        }
        return kept;
    }
}
