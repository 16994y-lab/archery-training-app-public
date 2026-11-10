# 弓行记网页自托管

本指南适用于个人训练网页。邮箱密码由你自己的 Supabase Auth 验证，计划、分数和训练历史保存在你自己的 PostgreSQL 中。用户在另一个浏览器登录同一邮箱后，打开「复盘」即可从服务端读回已确认的训练记录。

## 1. 准备自己的 Supabase 和数据库

需要 Node.js 22.12+、Python 3.12+、PostgreSQL 15+ 和一个独立的 Supabase 项目。

1. 在 Supabase Auth 启用邮箱密码登录。确保项目当前用于签发令牌的密钥是 **ECC P-256 (ES256)**。将 Site URL 和允许的回调地址设为自己的站点，初次本地验收可使用 `http://127.0.0.1:8000`。
2. 测试时可先在 Supabase Auth 的用户管理页面创建并确认两个测试邮箱账号。若开放自助注册，请配置自己的邮件发送服务并验证真实确认邮件。
3. 从 Supabase 项目设置复制 HTTPS 项目地址和 **Publishable key**。网页只填写这两项；服务端通过公开 JWKS 验证令牌。

[Supabase 邮箱密码登录](https://supabase.com/docs/guides/auth/passwords) · [签名密钥](https://supabase.com/docs/guides/auth/signing-keys) · [回调地址](https://supabase.com/docs/guides/auth/redirect-urls)

用 PostgreSQL 管理账号连接维护数据库（例如 `postgres`），在 `psql` 中创建两个登录角色和专用空数据库。下例用交互提示输入各自的密码。

```sql
CREATE ROLE gongxingji_owner LOGIN;
\password gongxingji_owner
CREATE ROLE gongxingji_runtime LOGIN;
\password gongxingji_runtime
CREATE DATABASE gongxingji OWNER gongxingji_owner;
```

远程数据库使用 `sslmode=verify-full`。按数据库提供商的说明配置可信根证书。连接串密码中有特殊字符时，先做 URL 百分号编码。

## 2. 构建网页

进入 `frontend/`，将 `.env.example` 复制为 `.env.local`，填入自己的 Supabase 项目地址和公开密钥，然后执行：

```sh
npm ci
npm run build:legacy
```

生成目录为 `frontend/dist`。更换 Supabase 项目后需要重新构建网页。

## 3. 迁移专用空库并启动

进入 `backend/`，创建并激活 Python 虚拟环境，然后安装后端依赖：

```sh
python -m venv .venv
# macOS / Linux 激活：source .venv/bin/activate
# Windows PowerShell 激活：.\.venv\Scripts\Activate.ps1
python -m pip install -e .
```

将 `.env.self-host.example` 复制为 `.env.self-host`。填写 `SUPABASE_URL` 和运行角色的 `DATABASE_URL`，并启用 `SELF_HOST_WEB_ROOT=../frontend/dist`。本地同源使用时可以省略 `CORS_ORIGINS`。

迁移时给当前终端临时设置所有者连接串。macOS / Linux 使用 `export MIGRATION_DATABASE_URL='你的所有者连接串'`，Windows PowerShell 使用 `$env:MIGRATION_DATABASE_URL='你的所有者连接串'`。连接串以 `postgresql+psycopg://gongxingji_owner:` 开头，指向同一个专用数据库。

```sh
python -m dotenv -f .env.self-host run -- python -m app.self_host_db migrate
```

看到迁移和运行角色权限通过后，清掉终端中的所有者连接串。macOS / Linux 使用 `unset MIGRATION_DATABASE_URL`，Windows PowerShell 使用 `Remove-Item Env:MIGRATION_DATABASE_URL`。然后启动网页和 API：

```sh
python -m uvicorn app.self_host:create_app --factory --env-file .env.self-host --host 127.0.0.1 --port 8000 --no-access-log
```

浏览器打开 `http://127.0.0.1:8000`。将服务放到自己的服务器时，让 HTTPS 反向代理同时转发网页和 `/api/`，保留同源路径，并将 Supabase Site URL 改成该站点的 HTTPS 地址。

## 4. 验证训练记录恢复

1. 从「我的」用第一个邮箱登录。
2. 从「训练计划」使用模板、保存计划并开始训练。录入成绩，确认完成或提前结束并保存。
3. 打开「复盘」，点开刚才的记录，核对箭数和总分。
4. 用无痕窗口重新登录同一邮箱，在「复盘」查看同一场训练。
5. 再开一个独立浏览器会话，登录第二个账号。第二个账号应显示自己的训练历史，空账号应显示暂无记录。

本模板覆盖网页、邮箱密码、训练计划、手动记分和训练历史。照片与附件存储、手机验证码、官方应用更新、移动端云备份和安卓打包属于其他部署范围。请将数据库连接串和邮件服务密钥保留在自己的服务端配置中。
