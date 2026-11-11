# 弓行记安卓离线开发版

这套模板从公开源码生成「弓行记 · 离线开发版」。训练、记分、复盘、代表性资讯和本机资料均可离线使用。应用的安装标识是 `app.gongxingji.training.offline`，本机记录保存在这个应用自己的数据目录。

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

开发版的安装标识、调试签名与正式版各自独立。「资讯」使用带来源和核对日期的本地选读与赛历。照片可逐箭人工核对，模拟靶纸的练习结果留在练习页。本机训练记录可复盘，海报与单场数据可通过系统文件选择器保存。账号、云同步、团队和应用更新页面会显示其离线状态。

[Android 命令行构建](https://developer.android.com/build/building-cmdline) · [Android 应用签名](https://developer.android.com/studio/publish/app-signing)

## 配图来源及许可

下列配图适用所列许可；资料图的年份、出处及调整在使用位置注明。

| 文件 | 署名与出处 | 许可 |
| --- | --- | --- |
| `arena-carioca-3.jpg` | Carol Delmazo / Brasil2016.gov.br，[Arena Carioca 3，2016](https://commons.wikimedia.org/wiki/File:Arena_Carioca_3.jpg) | [CC BY 3.0 Brasil](https://creativecommons.org/licenses/by/3.0/br/) |
| `plos-one-stability-study-figure-1.png`（同图在共享资讯资源中保留一份） | © 2023 Shinohara 等 / PLOS ONE，[原论文图 1](https://doi.org/10.1371/journal.pone.0285223.g001) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `frontiers-aiming-rhythm-figure-1.webp` | Jacquot 等，2025 / Frontiers，[原论文图 1](https://www.frontiersin.org/journals/sports-and-active-living/articles/10.3389/fspor.2025.1650300/full) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `frontiers-hand-dexterity-figure-1.webp` | Gao 等，2026 / Frontiers，[原论文图 1](https://www.frontiersin.org/journals/physiology/articles/10.3389/fphys.2026.1880932/full) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `michele-frangilli-2004.jpg` | Fieldarcher.org，[Michele Frangilli，2004 年资料照](https://commons.wikimedia.org/wiki/File:Michele_Frangilli_001.jpg) | [CC BY 3.0 Netherlands](https://creativecommons.org/licenses/by/3.0/nl/) |
| `nanjing-xuanwu-yingzhou-2014.webp` | helkonig，[南京玄武湖樱洲，2014 年资料图](https://commons.wikimedia.org/wiki/File:%E5%8D%97%E4%BA%AC%E7%8E%84%E6%AD%A6%E6%B9%96%E6%A8%B1%E6%B4%B2_-_panoramio_(1).jpg)，缩放并转为 WebP | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |

公开源码保留独立的离线账号、资讯及赛历适配。离线包不连接正式账号、云保存或应用更新服务。比赛计时支持本机计时；同一电脑的浏览器可另开副屏。正式版的同 Wi-Fi 原生接收服务与跨网配对不在离线包中启用。

资讯页雪狐吉祥物 `furry-arctic-fox.png` 为本项目自有生成 UI 素材，本仓库随附原图。
