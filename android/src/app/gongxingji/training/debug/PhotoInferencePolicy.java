package app.gongxingji.training.debug;

/** Fixed diagnostics only; no photo, account, path or exception values enter logs. */
final class PhotoInferencePolicy {
    // App bitness does not necessarily describe its WebView renderer.
    static final int WORK_MAX_LONG_EDGE = 256;
    static final boolean STAGE_LOGS_ENABLED = true;
    private String lastStage = "IDLE";
    private boolean active;
    private int events;
    synchronized void reset(){lastStage="IDLE";active=false;events=0;}
    synchronized String accept(String value){
        String stage=canonical(value);
        if(stage==null)return null;
        if("PHOTO_BEGIN".equals(stage)){active=true;events=0;}
        else if(!active||events>=64)return null;
        events++;
        if("RESULT_READY".equals(stage)||"PHOTO_FAILED".equals(stage)||"CANCELLED".equals(stage)||"TIMEOUT".equals(stage))active=false;
        lastStage=stage;return stage;
    }
    synchronized String rendererExit(boolean crashed){return (crashed?"RENDERER_CRASH AFTER_":"RENDERER_KILLED AFTER_")+lastStage;}
    private static String canonical(String value){
        if(value==null||value.length()>24)return null;
        switch(value){
            case "PHOTO_BEGIN":return "PHOTO_BEGIN";
            case "IMAGE_READY":return "IMAGE_READY";
            case "TARGET_READY":return "TARGET_READY";
            case "INPUT_READY":return "INPUT_READY";
            case "WASM_CHECK":return "WASM_CHECK";
            case "WASM_READY":return "WASM_READY";
            case "RUNTIME_LOAD":return "RUNTIME_LOAD";
            case "RUNTIME_READY":return "RUNTIME_READY";
            case "MODEL_FETCH":return "MODEL_FETCH";
            case "MODEL_FETCH_DONE":return "MODEL_FETCH_DONE";
            case "SESSION_CREATE":return "SESSION_CREATE";
            case "SESSION_READY":return "SESSION_READY";
            case "TENSOR_READY":return "TENSOR_READY";
            case "INFERENCE_RUN":return "INFERENCE_RUN";
            case "INFERENCE_DONE":return "INFERENCE_DONE";
            case "DECODE_DONE":return "DECODE_DONE";
            case "RELEASE_START":return "RELEASE_START";
            case "RELEASE_DONE":return "RELEASE_DONE";
            case "RESULT_READY":return "RESULT_READY";
            case "PHOTO_FAILED":return "PHOTO_FAILED";
            case "CANCELLED":return "CANCELLED";
            case "TIMEOUT":return "TIMEOUT";
            default:return null;
        }
    }
}
