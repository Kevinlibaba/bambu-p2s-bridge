#!/usr/bin/env bash
#
# 一行命令安装：在一台和打印机同局域网、一直开着的 Linux 机器上跑
#
#     curl -fsSL https://raw.githubusercontent.com/Kevinlibaba/bambu-p2s-bridge/main/get.sh | bash
#
# 不需要 git，也不需要源码：只下载几个配置文件，镜像是预构建好的（amd64 / arm64）。
# 没装 Docker 的话会询问是否用 Docker 官方脚本装上（要 root）。
# 剩下的（找打印机、填访问码、生成密钥、启动、自检）交给 install.sh。
#
# 参数原样传给 install.sh，例如无人值守：
#     curl -fsSL …/get.sh | BAMBU_ACCESS_CODE=xxxxxxxx bash -s -- --yes
#
# 环境变量：
#     BAMBU_DIR   安装目录（默认 ~/bambu-p2s-bridge，root 下默认 /opt/bambu-p2s-bridge）
#     BAMBU_SRC   从哪里取文件（默认 GitHub main 分支；可以是本地目录，测试用）
#
set -euo pipefail

SRC="${BAMBU_SRC:-https://raw.githubusercontent.com/Kevinlibaba/bambu-p2s-bridge/main}"

if [ -t 1 ]; then
  B=$'\033[1m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; N=$'\033[0m'
else
  B=''; R=''; G=''; Y=''; N=''
fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==>%s %s%s%s\n' "$G" "$N" "$B" "$*" "$N"; }
die()  { printf '%s错误:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

# 走管道时标准输入是脚本本身，交互一律从终端读
confirm() {
  local ans
  [ -r /dev/tty ] || return 1
  read -r -p "$1 [y/N]: " ans </dev/tty || true
  [[ "${ans:-}" =~ ^[Yy]$ ]]
}

[ "$(uname -s)" = Linux ] || die "目前只支持 Linux（需要和打印机在同一局域网、能用宿主机网络的 Docker）。"
command -v curl >/dev/null 2>&1 || die "需要 curl"

IS_ROOT=0
[ "$(id -u)" = 0 ] && IS_ROOT=1
RERUN="curl -fsSL $SRC/get.sh | sudo bash"

# ---------- Docker ----------
step "检查 Docker"
if ! command -v docker >/dev/null 2>&1; then
  [ "$IS_ROOT" = 1 ] || die "没有 Docker。安装 Docker 需要 root，请用 sudo 重跑：
    $RERUN"
  say "  没有找到 Docker。"
  confirm "  用 Docker 官方脚本（get.docker.com）现在安装？" || die "需要先装好 Docker：https://docs.docker.com/engine/install/"
  curl -fsSL https://get.docker.com | sh
fi
if ! docker info >/dev/null 2>&1; then
  if [ "$IS_ROOT" = 0 ]; then
    die "当前用户用不了 Docker（没在 docker 组里，或守护进程没启动）。用 sudo 重跑：
    $RERUN"
  fi
  systemctl start docker 2>/dev/null || service docker start 2>/dev/null || true
  docker info >/dev/null 2>&1 || die "Docker 守护进程起不来，先看 systemctl status docker"
fi
docker compose version >/dev/null 2>&1 || die "Docker 缺少 compose 插件：https://docs.docker.com/compose/install/"
say "  docker $(docker version --format '{{.Server.Version}}')，架构 $(uname -m)"

# ---------- 下载 ----------
if [ -n "${BAMBU_DIR:-}" ]; then DIR="$BAMBU_DIR"
elif [ "$IS_ROOT" = 1 ]; then DIR=/opt/bambu-p2s-bridge
else DIR="$HOME/bambu-p2s-bridge"; fi

step "下载到 $DIR"
mkdir -p "$DIR/scripts"
fetch() {  # fetch <仓库里的路径> <目标>
  if [ -d "$SRC" ]; then cp "$SRC/$1" "$2"
  else curl -fsSL "$SRC/$1" -o "$2"; fi
}
# docker-compose.yml 用预构建镜像版；已有的话也覆盖 —— 它不放用户自己的配置，配置都在 .env
fetch deploy/docker-compose.yml "$DIR/docker-compose.yml"
fetch go2rtc.yaml "$DIR/go2rtc.yaml"
fetch install.sh "$DIR/install.sh"
fetch scripts/discover.py "$DIR/scripts/discover.py"
chmod +x "$DIR/install.sh"
say "  完成"

cd "$DIR"
exec ./install.sh "$@"
