# Copr make_srpm 入口：Copr 在仓库根目录执行 `make -f .copr/Makefile srpm outdir=<dir>`。
outdir ?= $(CURDIR)/.temp/copr

srpm:
	sh $(dir $(lastword $(MAKEFILE_LIST)))srpm.sh "$(outdir)"

.PHONY: srpm
