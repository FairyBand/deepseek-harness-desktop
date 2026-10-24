# Copr make_srpm 入口：Copr 执行 `make -f .copr/Makefile srpm outdir=<dir> spec=<包的 spec 设置>`。
# Copr 只透传 outdir 与 spec 两个变量，渠道借 spec 传递：beta 项目的包把 spec 设为 `beta`，
# 其余一律按 stable 构建。本地验证可直接 `make -f .copr/Makefile srpm channel=beta`。
outdir ?= $(CURDIR)/.temp/copr
channel ?= $(if $(filter beta,$(notdir $(spec))),beta,stable)

srpm:
	sh $(dir $(lastword $(MAKEFILE_LIST)))srpm.sh "$(outdir)" "$(channel)"

.PHONY: srpm
