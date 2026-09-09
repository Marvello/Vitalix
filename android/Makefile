# Vitalix Android — command shortcuts (like npm scripts).
# Run from android/:  make test   make build   make dev
# Override the wrapper with:  make test GRADLE=gradle
GRADLE ?= ./gradlew

.DEFAULT_GOAL := help
.PHONY: help build test lint check install dev run clean uninstall build-beta install-beta

help: ## List available commands
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  make %-14s %s\n", $$1, $$2}'

build: ## Assemble the debug APK (production flavor)
	$(GRADLE) assembleProductionDebug

test: ## Run unit tests (both flavors — what CI runs)
	$(GRADLE) testProductionDebugUnitTest testBetaDebugUnitTest

lint: ## Run Android lint
	$(GRADLE) lint

check: ## Full local gate: build + test + lint
	$(GRADLE) assembleProductionDebug testProductionDebugUnitTest testBetaDebugUnitTest lint

install: ## Build + install to the connected device/emulator (production)
	$(GRADLE) installProductionDebug

dev: install ## Alias for install (build + deploy to device)

run: install ## Install then launch the app on the device
	adb shell monkey -p com.android.vitalix -c android.intent.category.LAUNCHER 1

clean: ## Delete build outputs
	$(GRADLE) clean

uninstall: ## Remove the app from the device
	$(GRADLE) uninstallProductionDebug

build-beta: ## Assemble the debug APK (beta flavor)
	$(GRADLE) assembleBetaDebug

install-beta: ## Build + install the beta flavor
	$(GRADLE) installBetaDebug
