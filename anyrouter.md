 OpenAI Codex 使用方式

1️⃣ 安装 Node.js

与 Claude Code 步骤 1️⃣ 相同

2️⃣ 安装 codex


npm i -g @openai/codex
codex --version


3️⃣ 开始使用


获取 Auth Token： 注册后在 API令牌 页面点击 添加令牌 获得（以 sk- 开头）
名称随意，额度建议设为无限额度，其他保持默认设置即可

创建 ~/.codex/config.toml 文件，并添加如下配置：
model = "gpt-5.3-codex"
model_provider = "anyrouter"
preferred_auth_method = "apikey"


[model_providers.anyrouter]
name = "Any Router"
base_url = "https://anyrouter.top/v1"
wire_api = "responses"
创建 ~/.codex/auth.json 文件，并添加如下配置：
{
  "OPENAI_API_KEY":"sk-i9RqLsPgpdoXbGXKKPGqjDWMd8FCD93IFOjTXewEJge4VAg5"
}