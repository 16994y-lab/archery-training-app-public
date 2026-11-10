# R8 full release mode. Android XML component rules also come from aapt2.
# Do not blanket-keep the application package: private implementation may shrink.
-keepattributes RuntimeVisibleAnnotations,AnnotationDefault,InnerClasses,EnclosingMethod,Signature
-renamesourcefileattribute Source

# WebView discovers these annotated methods reflectively by their Java names.
# The Java bridge class itself may be renamed; the exposed member names may not.
-keepclassmembers,allowoptimization class app.gongxingji.training.debug.MainActivity$Bridge {
    @android.webkit.JavascriptInterface <methods>;
}

# Components are loaded by Android from the manifest, not by ordinary Java code.
-keep,allowoptimization class app.gongxingji.training.debug.MainActivity {
    public <init>();
}
-keep,allowoptimization class app.gongxingji.training.debug.ReportProvider {
    public <init>();
}
-keep,allowoptimization class app.gongxingji.training.debug.CaptureProvider {
    public <init>();
}

# ONNX Runtime uses JNI to look up tensor, enum, exception and session classes.
# Keep the vendor ABI; application implementation remains shrinkable.
-keep class ai.onnxruntime.** { *; }
# Vendor compile-time AndroidX annotations have no executable references.
# All JNI classes/members above are retained independently of @Keep.
-dontwarn androidx.annotation.Keep
-dontwarn androidx.annotation.NonNull
-dontwarn androidx.annotation.Nullable
-dontwarn androidx.annotation.RequiresApi
