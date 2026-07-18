# featherdrop — task runner. Run `just` (or `just --list`) to see recipes.
# Frontend: Vite + React SPA. Backend: Go (server-go/). Image: distroless static.
set shell := ["sh", "-cu"]

# Show all recipes
default:
    @just --list

# ---------------------------------------------------------------------------
# Frontend (repo root)
# ---------------------------------------------------------------------------

# Install node deps (runs the libsodium postinstall workaround)
install:
    npm install --no-audit --no-fund

# Vite dev server for the SPA (http://localhost:5173)
dev:
    npm run dev

# Build the Vite SPA into server-go/webroot (what the image does)
build-spa:
    npm run build:spa

# ESLint (max-warnings 0)
lint:
    npm run lint

# TypeScript typecheck (no emit)
typecheck:
    npx tsc --noEmit

# Logic tests (node test runner + tsx)
test:
    npm test

# Playwright browser round-trips
test-browser:
    npm run test:browser

# ---------------------------------------------------------------------------
# Backend (server-go/)
# ---------------------------------------------------------------------------

# Format Go code in place
go-fmt:
    cd server-go && gofmt -w .

# Fail if any Go file is unformatted (CI gate)
go-fmt-check:
    cd server-go && test -z "$(gofmt -l .)" || { echo "gofmt: unformatted files:"; gofmt -l server-go; exit 1; }

# go vet
go-vet:
    cd server-go && CGO_ENABLED=0 go vet ./...

# go test
go-test:
    cd server-go && CGO_ENABLED=0 go test ./... -count=1

# Vulnerability scan of deps + stdlib (CI gate)
go-vuln:
    cd server-go && go run golang.org/x/vuln/cmd/govulncheck@latest ./...

# Run the Go server (serves SPA + API on :3000, data under ./data)
go-run:
    cd server-go && go run .

# ---------------------------------------------------------------------------
# Format everything
# ---------------------------------------------------------------------------

# Format Go (frontend is checked by ESLint, not auto-formatted here)
fmt: go-fmt

# ---------------------------------------------------------------------------
# Container
# ---------------------------------------------------------------------------

# Build the full multi-stage image for the local platform
docker-build:
    docker build -t featherdrop:local .

# Build the amd64 image, boot it, require it to serve / (mirrors CI smoke)
docker-smoke:
    docker build -t featherdrop:smoke .
    docker run -d --name fd-smoke -p 3000:3000 featherdrop:smoke
    sh -c 'for i in $(seq 1 40); do curl -fsS -o /dev/null http://localhost:3000/ && break || sleep 1; done'
    docker rm -f fd-smoke

# ---------------------------------------------------------------------------
# Aggregate + security
# ---------------------------------------------------------------------------

# Full local check: frontend lint/typecheck/test + Go fmt/vet/test
check: lint typecheck test go-fmt-check go-vet go-test

# Scan the working tree + history for secrets
secrets:
    gitleaks detect --no-banner --redact
