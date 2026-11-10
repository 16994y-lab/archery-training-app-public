# 弓行记安卓离线开发版

这套模板从公开源码生成「弓行记 · 离线开发版」。训练、手动记分和复盘在本机运行。应用的安装标识是 `app.gongxingji.training.offline`，本机记录保存在这个应用自己的数据目录。

## 1. 准备工具

- Node.js 22.12 或更新版本、Python 3.12 或更新版本、JDK 21。
- 在 Android Studio 的 SDK Manager 中安装 Android SDK Platform 35、Android SDK Build-Tools 35.0.0 和 Android SDK Platform-Tools。
- 手机须运行 Android 8.0（API 26）或更新版本。通过 USB 安装时，在手机开启 USB 调试，并在连接后确认授权。

构建脚本会查找常见 SDK 安装目录，也可以通过 `ANDROID_HOME` 和 `JAVA_HOME` 指定目录。需要显式选择时，用 `python android/offline-dev/build.py --help` 查看参数。

## 2. 构建并签名

从项目根目录运行：

```sh
cd frontend
npm ci
npm run build:android-offline
cd ..
python android/offline-dev/build.py
```

APK 路径是 `android/offline-dev/build/Gongxingji-offline-dev.apk`。首次构建会在本地生成调试签名，之后的构建复用它。保留 `android/offline-dev/.local/`，这样重新打包后可以覆盖更新自己的开发版并保留其中的练习数据。构建目录和签名目录均由 Git 忽略。

如果 SDK 或 JDK 不在默认位置，可以在项目根目录使用 `python android/offline-dev/build.py --sdk "<SDK 目录>" --jdk "<JDK 目录>"`。

## 3. 安装和验收

确保 SDK 的 `platform-tools` 在命令搜索路径里，或直接使用其中的 `adb`。只连接一台已授权的手机，然后执行：

```sh
adb devices
adb install -r android/offline-dev/build/Gongxingji-offline-dev.apk
```

1. 在手机上确认能分别找到「弓行记」和「弓行记 · 离线开发版」。通过桌面图标打开开发版。
2. 打开飞行模式并断开 Wi-Fi。在开发版进入「训练」，新开一场训练。切换「数字录入」，分别记录一箭 X、一箭 10 和一箭 M。
3. 选择「结束训练」和「结束并查看分析」。如果提示还有未录入的箭，选择仅保存已经录入的 3 箭。核对本场为 3 箭、总分 20。
4. 在系统设置里强制停止**开发版**，再从桌面打开它。进入「复盘」点开刚才的训练，核对 3 箭、总分 20 和逐箭成绩。测试后恢复手机原来的联网设置。

开发版的安装标识、调试签名与正式版各自独立。该模板的构建范围是本机个人训练和复盘，云账号、资讯、照片模型、官方应用更新与正式发布使用各自的流程。

[Android 命令行构建](https://developer.android.com/build/building-cmdline) · [Android 应用签名](https://developer.android.com/studio/publish/app-signing)
