# 云端常驻监控原型

此目录提供一个通用 Docker 部署原型，当前尚未连接或创建任何云主机。它只读取预约周历，不会选择场次或提交预约。

## 监控时段

默认使用 `Asia/Shanghai` 时区：每天 06:55–07:05 每 10 秒启动一轮检查，其余时间每 30 分钟检查。可在 `booking_targets.json` 的 `schedule` 中调整时区、窗口和两个间隔。当前场馆列表默认不含张江。

间隔表示两轮完整扫描之间的等待时间；一轮会逐个打开所选场馆页面，因此实际完成一轮可能超过 10 秒。

## 云端登录和数据

服务器启动后会提供仅绑定在服务器本机的 noVNC 页面。通过 SSH 隧道访问它，在云端浏览器中由你本人登录校园预约平台。VNC 本身不设独立密码，因此 SSH 端口转发是必需的；不要把 6080 端口暴露到公网。浏览器会话保存在 Docker 持久卷 `/data`；不会复制本机 Chrome 的 Cookie，也不需要把校园账号密码交给脚本。

此方式仍会把登录会话保存在云服务器上。请使用你自己的云账号和受限 SSH 访问；不要把 `.env`、`/data` 或服务器备份分享给他人。需要退出云端登录时，在浏览器中退出预约平台并删除 Docker 持久卷。

## iPhone 邮件提醒

可在服务器的 `.env` 设置 SMTP 参数。iCloud Mail 的服务器是 `smtp.mail.me.com`、端口 `587`、需要 SMTP 认证；密码必须使用 Apple 生成的 app-specific password。脚本只读取环境变量，不把密码写入代码或镜像。Apple 说明：[iCloud Mail 服务器设置](https://support.apple.com/en-us/102525)、[app-specific passwords](https://support.apple.com/en-us/102654)。

如未配置 SMTP，发现空场时只尝试本机桌面通知并写入日志；在云服务器上通常无法向 iPhone 提醒。

## 部署前置条件

- 一台 Linux 云主机，建议位于中国大陆区域以便访问校园预约平台。
- Docker Compose。
- SSH 密钥登录权限。noVNC 端口映射到服务器 `127.0.0.1:6080`，不应在云安全组开放公网访问。
- 如需邮件通知，先在 Apple 账号页面创建 app-specific password，再把它填入服务器 `.env`；不要发给我。

在 `python-monitor` 目录执行以下步骤。

1. 复制 `booking_targets.example.json` 为 `booking_targets.json`，按需调整场馆和检查间隔。
2. 复制 `.env.example` 为 `.env`，将权限设为仅服务器用户可读。需要邮件提醒时填写 SMTP 参数。
3. 执行 `docker compose up -d --build`。
4. 在本地用 SSH 建立隧道：`ssh -L 6080:127.0.0.1:6080 <服务器用户>@<服务器地址>`。
5. 浏览器打开 `http://127.0.0.1:6080/vnc.html`，在云端浏览器窗口登录校园预约系统。
6. 确认日志出现周历扫描结果，再用 `docker compose logs -f` 查看运行状态。

这只是可迁移的部署包；购买或创建云主机前仍需确认云厂商、区域、价格和登录方案。
