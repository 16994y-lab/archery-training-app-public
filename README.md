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

## 发布范围

此快照提供源码与本地构建所需的基础配置。随附基础图标与 Barlow 字体的原许可。资讯正文使用空的本地数据模板。正式服务配置、新闻图片和其他媒体、模型、签名材料、Android 打包脚本和安装包单独管理。网页可构建，移动端可运行类型检查，正式 Android 包需要这些额外输入。

项目源码采用 [MIT 许可](LICENSE)。随附的 Barlow 字体继续适用其 [SIL Open Font License](frontend/public/fonts/OFL-Barlow.txt)。
