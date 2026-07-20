#
# Makefile to simplify deployment. Almost certainly only useful to me!
#

.PHONY: *

# Load .env. Copy .env.example to .env and edit
-include .env

HOST ?= your-server
DIR ?= /opt/emfcamp-schedule
HOST_IS_BAREMETAL ?= 0

STATIC_FILES = index.html styles.css app.js serviceworker.js icons
FILES = $(STATIC_FILES) nginx.conf compose.yaml

list:
	@grep -E '^[a-zA-Z%_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'

up: ## Run the full site locally in Docker (nginx + favourites relay) at http://127.0.0.1:8090
	docker compose up --force-recreate

down: ## Stop and remove the local Docker stack
	docker compose down

icons: ## Regenerate the PNG icons and favicon.ico from icons/icon.svg
	@command -v rsvg-convert >/dev/null || { echo "needs rsvg-convert (librsvg)"; exit 1; }
	@command -v magick >/dev/null || { echo "needs ImageMagick (magick)"; exit 1; }
	sed 's/ rx="112"//' icons/icon.svg > /tmp/emf-icon-square.svg
	rsvg-convert -w 180 -h 180 /tmp/emf-icon-square.svg -o icons/apple-touch-icon.png
	rsvg-convert -w 192 -h 192 /tmp/emf-icon-square.svg -o icons/icon-192.png
	rsvg-convert -w 512 -h 512 /tmp/emf-icon-square.svg -o icons/icon-512.png
	rsvg-convert -w 16 -h 16 icons/icon.svg -o /tmp/emf-icon-16.png
	rsvg-convert -w 32 -h 32 icons/icon.svg -o /tmp/emf-icon-32.png
	rsvg-convert -w 48 -h 48 icons/icon.svg -o /tmp/emf-icon-48.png
	magick /tmp/emf-icon-16.png /tmp/emf-icon-32.png /tmp/emf-icon-48.png icons/favicon.ico
	rm -f /tmp/emf-icon-square.svg /tmp/emf-icon-16.png /tmp/emf-icon-32.png /tmp/emf-icon-48.png
	@echo "==> Regenerated icons in icons/"

deploy: ## Copy the site to the server (recreate the Docker stack unless HOST_IS_BAREMETAL=1)
	ssh $(HOST) 'mkdir -p $(DIR)'
ifeq ($(HOST_IS_BAREMETAL),1)
	rsync -av $(STATIC_FILES) $(HOST):$(DIR)/
	@echo "==> Done. Deployed static files to $(HOST):$(DIR)"
else
	rsync -av $(FILES) $(HOST):$(DIR)/
	ssh $(HOST) 'cd $(DIR) && docker compose up -d --force-recreate'
	@echo "==> Done. Container status:"
	ssh $(HOST) 'cd $(DIR) && docker compose ps'
endif

logs: ## Tail the emf-schedule container logs on the server
	ssh $(HOST) 'cd $(DIR) && docker compose logs -f emf-schedule'
