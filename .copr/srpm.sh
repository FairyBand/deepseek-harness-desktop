#!/bin/sh
# 生成 Copr 用的 SRPM。只构建发布版：HEAD 必须带 `copr/<package.json 版本>-<Release>` tag，
# 例如 `copr/0.25.0-1`；同一版本补打包修复时递增 Release。Version 里不能出现 `-`（dnfdragora
# 等前端会因此无法启动），预发布的 `-rc.1` 一律改写成 `~rc.1`，排序在正式版之前。
set -eu

outdir=$1
top=$(cd "$(dirname "$0")/.." && pwd)

command -v git >/dev/null 2>&1 || dnf -y install git-core
command -v rpmbuild >/dev/null 2>&1 || dnf -y install rpm-build

# Copr 在 mock 里以 root 处理别的用户克隆的仓库，git 会因 safe.directory 拒绝工作
repo() {
  git -c safe.directory='*' -C "$top" "$@"
}

raw=$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' "$top/package.json")
[ -n "$raw" ] || { echo "SRPM_VERSION_MISSING: package.json has no version" >&2; exit 1; }
release=
for tag in $(repo tag --points-at HEAD); do
  n=${tag#"copr/$raw-"}
  case $n in "$tag" | '' | *[!0-9]*) continue ;; esac
  [ -n "$release" ] && [ "$release" -ge "$n" ] || release=$n
done
[ -n "$release" ] || {
  echo "SRPM_NOT_RELEASE: HEAD has no copr/$raw-<N> tag; tag a release first, e.g. git tag copr/$raw-1" >&2
  exit 1
}
version=$(printf '%s' "$raw" | tr '-' '~')
packager=$(repo log -1 --format='%an <%ae>')

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
prefix="dsh-tauri-$version"

# 打包工作区而非 HEAD：本地验证时未提交的改动也能进 SRPM；Copr 上两者一致
repo ls-files -z --cached --others --exclude-standard \
  | tar -C "$top" --null --no-recursion --ignore-failed-read -T - \
      --transform "flags=r;s|^|$prefix/|" -czf "$work/$prefix.tar.gz"

sed -e "s|@VERSION@|$version|" \
    -e "s|@RELEASE@|$release|" \
    -e "s|@PACKAGER@|$packager|" \
    -e "s|@DATE@|$(LC_ALL=C date '+%a %b %d %Y')|" \
    "$top/.copr/dsh-tauri.spec.in" > "$work/dsh-tauri.spec"

mkdir -p "$outdir"
rpmbuild -bs \
  --define "_sourcedir $work" \
  --define "_srcrpmdir $outdir" \
  "$work/dsh-tauri.spec"
