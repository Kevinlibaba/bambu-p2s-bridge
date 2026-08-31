#!/usr/bin/env bash
#
# 一键部署。在一台与打印机同局域网的 Linux 机器上跑：
#
#     ./install.sh
#
# 它会自动发现打印机、生成密钥、构建并启动，最后把访问地址打出来。
# 需要你提供的只有打印机屏幕上那串 8 位访问码。
#
# 非交互（CI / 无人值守）：
#     BAMBU_ACCESS_CODE=xxxxxxxx ./install.sh --yes
#
set -euo pipefail

cd "$(dirname "$0")"

# ---------- 输出 ----------
if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; N=$'\033[0m'
else
  B=''; DIM=''; R=''; G=''; Y=''; N=''
fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==>%s %s%s%s\n' "$G" "$N" "$B" "$*" "$N"; }
warn() { printf '%s警告:%s %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '%s错误:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

ASSUME_YES=0
SKIP_TAILSCALE=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    --no-tailscale) SKIP_TAILSCALE=1 ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) die "未知参数: $arg（--help 看用法）" ;;
  esac
done

ask() {  # ask <提示> <默认值>
  local prompt="$1" def="${2:-}" ans
  if [ "$ASSUME_YES" = 1 ]; then printf '%s' "$def"; return; fi
  if [ -n "$def" ]; then read -r -p "$prompt [$def]: " ans </dev/tty || true
  else read -r -p "$prompt: " ans </dev/tty || true; fi
  printf '%s' "${ans:-$def}"
}

confirm() {  # confirm <提示>  —— 默认否
  [ "$ASSUME_YES" = 1 ] && return 0
  local ans
  read -r -p "$1 [y/N]: " ans </dev/tty || true
  [[ "${ans:-}" =~ ^[Yy]$ ]]
}

# ---------- 1. 环境检查 ----------
step "检查环境"
command -v docker >/dev/null 2>&1 || die "没有 docker。参考 https://docs.docker.com/engine/install/"
docker info >/dev/null 2>&1 || die "docker 守护进程没在跑，或当前用户没有权限（试试 sudo，或把自己加进 docker 组）"
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  die "没有 docker compose 插件。参考 https://docs.docker.com/compose/install/"
fi
command -v python3 >/dev/null 2>&1 || warn "没有 python3，跳过打印机自动发现，需要手动填 IP 与序列号"
say "  docker $(docker version --format '{{.Server.Version}}')，compose 可用"

# ---------- 2. 已有配置 ----------
ENV_FILE=.env
KEEP_ENV=0
if [ -f "$ENV_FILE" ]; then
  say ""
  say "已存在 $ENV_FILE。"
  if confirm "沿用它，只重新构建并启动？"; then
    KEEP_ENV=1
  else
    cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%s)"
    say "  旧配置已备份为 $ENV_FILE.bak.*"
  fi
fi

if [ "$KEEP_ENV" = 0 ]; then
  # ---------- 3. 发现打印机 ----------
  step "查找打印机"
  HOST=""; SERIAL=""
  if command -v python3 >/dev/null 2>&1; then
    say "  监听 SSDP 广播，约 8 秒…"
    FOUND=$(python3 scripts/discover.py --json --timeout 8 2>/dev/null || echo '[]')
    COUNT=$(printf '%s' "$FOUND" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)
    if [ "$COUNT" -ge 1 ]; then
      python3 - <<'PY' <<<"$FOUND"
import sys, json
for i, p in enumerate(json.load(sys.stdin), 1):
    model = p["model"] or "未知型号"
    print(f"  {i}) {p['ip']}  {model}  序列号 {p['serial']}")
PY
      IDX=1
      [ "$COUNT" -gt 1 ] && IDX=$(ask "  选一台（序号）" 1)
      HOST=$(printf '%s' "$FOUND"   | python3 -c "import sys,json;print(json.load(sys.stdin)[$IDX-1]['ip'])")
      SERIAL=$(printf '%s' "$FOUND" | python3 -c "import sys,json;print(json.load(sys.stdin)[$IDX-1]['serial'])")
      say "  选中 $HOST（$SERIAL）"
    else
      warn "没发现打印机 —— 可能路由器开了组播隔离。手动填即可。"
    fi
  fi
  [ -n "$HOST" ]   || HOST=$(ask "  打印机 IP")
  [ -n "$SERIAL" ] || SERIAL=$(ask "  打印机序列号（机器 设置→设备 里能看到）")
  [ -n "$HOST" ] && [ -n "$SERIAL" ] || die "IP 和序列号都不能为空"

  # ---------- 4. 访问码 ----------
  step "访问码"
  CODE="${BAMBU_ACCESS_CODE:-}"
  if [ -z "$CODE" ]; then
    say "  在打印机上：设置 → 通用 → 局域网模式，8 位字母数字。"
    CODE=$(ask "  访问码")
  fi
  [[ "$CODE" =~ ^[A-Za-z0-9]{8}$ ]] || die "访问码应当是 8 位字母数字，收到的是「$CODE」"

  # ---------- 5. 生成配置 ----------
  step "生成配置"
  TOKEN=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
  [ ${#TOKEN} -eq 48 ] || die "生成 API_TOKEN 失败"
  umask 077
  cat > "$ENV_FILE" <<EOF
# 由 install.sh 生成于 $(date -Iseconds)
BAMBU_HOST=$HOST
BAMBU_SERIAL=$SERIAL
BAMBU_ACCESS_CODE=$CODE

# 接口鉴权。手机端要填这一串。
API_TOKEN=$TOKEN

PORT=8080
BIND_HOST=0.0.0.0
GO2RTC_URL=http://127.0.0.1:1984
GO2RTC_STREAM=bambu_p2s
ALLOW_RAW_GCODE=false
PUSHALL_INTERVAL_MS=300000
HISTORY_PATH=/data/jobs.jsonl

# 通知。留空即关闭；Web Push 的密钥在下面由脚本补上。
NOTIFY_ENABLED=true
NOTIFY_EVENTS=all
NOTIFY_LANG=zh-Hans
EOF
  chmod 600 "$ENV_FILE"
  say "  已写入 $ENV_FILE（权限 600）"
fi

mkdir -p data && chmod 700 data

# ---------- 6. 构建 ----------
step "构建镜像（首次约几分钟）"
$DC build

# ---------- 7. Web Push 密钥 ----------
# 放在构建之后：直接用镜像里的 web-push 生成，宿主机不需要装 Node
if ! grep -q '^VAPID_PRIVATE_KEY=.\+' "$ENV_FILE" 2>/dev/null; then
  step "生成 Web Push 密钥"
  KEYS=$(docker run --rm --entrypoint node "$($DC config --images | grep -v go2rtc | head -1)" \
        -e 'const k=require("web-push").generateVAPIDKeys();console.log(k.publicKey+" "+k.privateKey)' 2>/dev/null || true)
  if [ -n "$KEYS" ]; then
    PUB=${KEYS%% *}; PRIV=${KEYS##* }
    # sub 必须是可路由的 mailto: 或 https:；Apple 会拒绝 .local 之类并回 403
    SUBJ=$(ask "  联系方式（邮箱或本服务的公开地址，Apple 会校验）" "mailto:admin@example.com")
    sed -i '/^VAPID_/d' "$ENV_FILE"
    cat >> "$ENV_FILE" <<EOF
VAPID_PUBLIC_KEY=$PUB
VAPID_PRIVATE_KEY=$PRIV
VAPID_SUBJECT=$SUBJ
EOF
    say "  已生成，装到主屏后即可在设置页开启推送"
  else
    warn "生成失败，跳过。Web Push 不可用，其余功能不受影响。"
  fi
fi

# ---------- 8. 启动 ----------
step "启动"
$DC up -d
sleep 4

# ---------- 9. 自检 ----------
step "自检"
PORT_N=$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2); PORT_N=${PORT_N:-8080}
TOKEN_N=$(grep -E '^API_TOKEN=' "$ENV_FILE" | cut -d= -f2)
OK=0
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT_N/api/health" >/tmp/.bambu_health 2>/dev/null; then OK=1; break; fi
  sleep 2
done
if [ "$OK" = 1 ]; then
  say "  接口已就绪：$(cat /tmp/.bambu_health)"
  rm -f /tmp/.bambu_health
  if command -v python3 >/dev/null 2>&1; then
    CONN=$(curl -fsS -H "Authorization: Bearer $TOKEN_N" "http://127.0.0.1:$PORT_N/api/state" 2>/dev/null \
      | python3 -c 'import sys,json;d=json.load(sys.stdin);print(("在线，状态 "+str(d.get("state"))) if d.get("online") else "尚未连上打印机")' 2>/dev/null || echo "读取状态失败")
    say "  打印机：$CONN"
  fi
else
  warn "接口没起来。看日志：$DC logs bridge"
fi

# ---------- 10. Tailscale ----------
URL="http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT_N"
if [ "$SKIP_TAILSCALE" = 0 ] && command -v tailscale >/dev/null 2>&1; then
  step "通过 Tailscale 对外暴露"
  say "  会拿到一个带正式证书的 https 地址，且只有你的 tailnet 能访问。"
  if confirm "  现在配置？"; then
    if tailscale serve --bg --https=443 "http://127.0.0.1:$PORT_N" >/dev/null 2>&1; then
      TS=$(tailscale status --json 2>/dev/null \
        | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)
      [ -n "$TS" ] && URL="https://$TS"
      say "  已配置。${DIM}切勿开启 Funnel —— 那是发布到公网。${N}"
    else
      warn "tailscale serve 失败，可能需要 sudo 或先 tailscale up。"
    fi
  fi
fi

# ---------- 完成 ----------
cat <<EOF

$B部署完成$N

  地址   $URL/app/
  Token  $TOKEN_N

手机上打开这个地址，在设置页填入地址和 Token。
iOS 想收推送的话，先「分享 → 添加到主屏幕」，再从主屏图标打开。

  查看日志   $DC logs -f bridge
  重启       $DC restart bridge
  停止       $DC down

Token 就在 .env 里（权限 600），别提交进版本库。
EOF
