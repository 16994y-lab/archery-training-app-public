# 弓行记 · Gongxingji

弓行记是个人射箭训练工具，包含训练计划、靶面与手动记分、历史复盘和统计。

## 源码结构

| 目录 | 内容 |
| --- | --- |
| `frontend/` | React / TypeScript 网页、移动端与工作台源码 |
| `backend/` | Python / FastAPI 接口、数据模型和迁移 |
| `android/` | Android Java 外壳、清单和原生测试源码 |

## 本地检查

网页需要 Node.js 22.12 或更高版本。以下命令在 `frontend/` 运行。

```sh
npm ci
npm run build
npm run check:mobile
node --test tests/*.test.mjs
```

`npm run dev` 启动网页开发服务器，并将 `/api` 转发至本机 8000 端口。

后端需要 Python 3.12 或更高版本。在 `backend/` 安装 `requirements.txt` 和 `pytest` 后，可以运行 `python -m pytest tests` 检查评分、训练契约和训练计划。SQLite 可用于核心测试。完整数据库迁移包含 PostgreSQL 专用结构，账号和云存储服务也需单独配置。

## 自托管

[网页自托管教程](docs/SELF_HOST.md)介绍如何使用自己的 PostgreSQL 和 Supabase 项目部署网页、启用邮箱登录，并在另一个浏览器读回已保存的训练记录。

## 安卓离线开发版

[安卓打包教程](docs/ANDROID_OFFLINE_DEV.md)介绍如何从公开源码生成独立的调试 APK，在手机上离线查看精选资讯和赛历，以及训练、记分和复盘。

## 发布范围

此快照提供源码与本地构建所需的基础配置。随附基础图标与 Barlow 字体的原许可。安卓离线开发版随附精选资讯、赛事快照和两张授权配图。正式服务配置、完整资讯数据、模型、正式签名材料和安装包单独管理。网页可构建，移动端可运行类型检查。

项目源码采用 [MIT 许可](LICENSE)。Barlow 字体适用 [SIL Open Font License](frontend/public/fonts/OFL-Barlow.txt)，随附配图适用各自的 [CC BY 许可](docs/ANDROID_OFFLINE_DEV.md#配图来源及许可)。
