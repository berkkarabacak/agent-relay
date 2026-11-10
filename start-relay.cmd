@echo off
cd /d "%~dp0"
if not exist node_modules call npm install
if not exist .env call npm run setup
if not exist dist call npm run build
start "AgentRelay" http://127.0.0.1:7100/
call npm start
