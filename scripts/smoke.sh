#!/usr/bin/env bash
#
# End-to-end smoke test against a running `npm run dev`.
#
#   npm run dev            # terminal 1
#   ./scripts/smoke.sh     # terminal 2
#
# Reads UPLOAD_PASSWORD from the environment or .dev.vars. Never touches production:
# ORIGIN defaults to the local Wrangler server.
#
# Set APP_TOKEN (plus a matching APP_TOKENS entry in .dev.vars) to also exercise
# the scoped-token checks; that section is skipped when APP_TOKEN is unset.

set -uo pipefail

ORIGIN="${ORIGIN:-http://localhost:8787}"
APP_TOKEN="${APP_TOKEN:-}"
APP_TOKEN_PREFIX="${APP_TOKEN_PREFIX:-heard}"

if [[ -z "${UPLOAD_PASSWORD:-}" && -f .dev.vars ]]; then
	UPLOAD_PASSWORD="$(grep -E '^UPLOAD_PASSWORD=' .dev.vars | head -1 | cut -d= -f2-)"
fi

if [[ -z "${UPLOAD_PASSWORD:-}" ]]; then
	echo "UPLOAD_PASSWORD is not set and .dev.vars has no UPLOAD_PASSWORD line." >&2
	exit 2
fi

PREFIX="smoke-$$"
PASS=0
FAIL=0

# check <name> <expected> <actual>
check() {
	if [[ "$2" == "$3" ]]; then
		printf 'ok   %-58s %s\n' "$1" "$3"
		PASS=$((PASS + 1))
	else
		printf 'FAIL %-58s expected %s, got %s\n' "$1" "$2" "$3"
		FAIL=$((FAIL + 1))
	fi
}

put_as() {
	local token="$1" key="$2" body="$3"
	shift 3
	curl -sS -o /dev/null -w '%{http_code}' -X PUT "$ORIGIN/api/objects" \
		-H "Authorization: Bearer $token" \
		-H "X-DXD-Object-Key: $key" \
		-H 'Content-Type: application/javascript' \
		"$@" \
		--data-binary "$body"
}

put() {
	local key="$1" body="$2"
	shift 2
	put_as "$UPLOAD_PASSWORD" "$key" "$body" "$@"
}

status() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }

header() {
	local name="$1"
	shift
	curl -sS -D - -o /dev/null "$@" | tr -d '\r' | grep -i "^$name:" | head -1 | cut -d' ' -f2-
}

echo "== Objects API: authenticated write =="
check 'PUT /api/objects (live default)' 201 "$(put "$PREFIX/app/prod/config.js" 'v1')"
check 'PUT /api/objects without auth' 401 \
	"$(curl -sS -o /dev/null -w '%{http_code}' -X PUT "$ORIGIN/api/objects" -H "X-DXD-Object-Key: $PREFIX/app/prod/x.js" --data-binary 'x')"
check 'PUT /api/objects with a non-allowlisted Cache-Control' 400 \
	"$(put "$PREFIX/app/prod/bad.js" 'x' -H 'X-DXD-Cache-Control: public, max-age=300')"

echo
echo "== Objects API: authenticated read =="
check 'GET /api/objects?as=meta' 200 \
	"$(status -H "Authorization: Bearer $UPLOAD_PASSWORD" "$ORIGIN/api/objects?key=$PREFIX/app/prod/config.js&as=meta")"
check 'GET /api/objects?as=meta without auth' 401 "$(status "$ORIGIN/api/objects?key=$PREFIX/app/prod/config.js&as=meta")"
check 'GET /api/objects?as=meta for a missing key' 404 \
	"$(status -H "Authorization: Bearer $UPLOAD_PASSWORD" "$ORIGIN/api/objects?key=$PREFIX/app/prod/nope.js&as=meta")"

echo
echo "== Public GET =="
check 'public GET' 200 "$(status "$ORIGIN/$PREFIX/app/prod/config.js")"
check 'public GET Cache-Control' 'public, max-age=0, must-revalidate' "$(header cache-control "$ORIGIN/$PREFIX/app/prod/config.js")"
check 'public GET CDN-Cache-Control' 'public, max-age=0, must-revalidate' "$(header cdn-cache-control "$ORIGIN/$PREFIX/app/prod/config.js")"
check 'public GET body' 'v1' "$(curl -sS "$ORIGIN/$PREFIX/app/prod/config.js")"

ETAG="$(header etag "$ORIGIN/$PREFIX/app/prod/config.js")"
check 'If-None-Match revalidates to 304' 304 "$(status -H "If-None-Match: $ETAG" "$ORIGIN/$PREFIX/app/prod/config.js")"
check 'If-Match mismatch is 412' 412 "$(status -H 'If-Match: "nope"' "$ORIGIN/$PREFIX/app/prod/config.js")"
check 'POST on a public object path is 405' 405 "$(status -X POST "$ORIGIN/$PREFIX/app/prod/config.js")"
check 'DELETE on a public object path is 405' 405 "$(status -X DELETE "$ORIGIN/$PREFIX/app/prod/config.js")"

echo
echo "== Republish a live key =="
check 'republish PUT' 201 "$(put "$PREFIX/app/prod/config.js" 'v2')"
check 'public GET serves the new bytes' 'v2' "$(curl -sS "$ORIGIN/$PREFIX/app/prod/config.js")"

echo
echo "== Version-shaped keys are object keys, not GitHub requests =="
check 'PUT a version-shaped key' 201 "$(put "$PREFIX/v1.2.3/bundle.js" 'ver1')"
check 'version-shaped key keeps its live policy' 'public, max-age=0, must-revalidate' \
	"$(header cache-control "$ORIGIN/$PREFIX/v1.2.3/bundle.js")"
check 'republish PUT on a version-shaped key' 201 "$(put "$PREFIX/v1.2.3/bundle.js" 'ver2')"
check 'version-shaped key serves the new bytes' 'ver2' "$(curl -sS "$ORIGIN/$PREFIX/v1.2.3/bundle.js")"

echo
echo "== Legacy GitHub-proxy URLs =="
check 'legacy shape with no object redirects' 301 "$(status "$ORIGIN/some-repo/v9.9.9/dist/app.js")"
check 'legacy redirect target' "$ORIGIN/gh/some-repo/v9.9.9/dist/app.js" "$(header location "$ORIGIN/some-repo/v9.9.9/dist/app.js")"
check 'a non-version-shaped miss stays 404' 404 "$(status "$ORIGIN/$PREFIX/app/prod/missing.js")"
check '/gh/ without a file path is 400' 400 "$(status "$ORIGIN/gh/some-repo/v9.9.9")"

if [[ -n "$APP_TOKEN" ]]; then
	echo
	echo "== Scoped app token (prefix $APP_TOKEN_PREFIX/) =="
	check 'app token writes inside its prefix' 201 "$(put_as "$APP_TOKEN" "$APP_TOKEN_PREFIX/$PREFIX/in-scope.js" 'x')"
	check 'app token cannot write outside its prefix' 403 "$(put_as "$APP_TOKEN" "other-app/$PREFIX/out-of-scope.js" 'x')"
	check 'app token cannot use a sibling prefix' 403 "$(put_as "$APP_TOKEN" "$APP_TOKEN_PREFIX-staging/$PREFIX/a.js" 'x')"
	check 'app token reads inside its prefix' 200 \
		"$(status -H "Authorization: Bearer $APP_TOKEN" "$ORIGIN/api/objects?key=$APP_TOKEN_PREFIX/$PREFIX/in-scope.js&as=meta")"
	check 'app token cannot read outside its prefix' 403 \
		"$(status -H "Authorization: Bearer $APP_TOKEN" "$ORIGIN/api/objects?key=other-app/$PREFIX/out-of-scope.js&as=meta")"
	check 'app token cannot list the whole bucket' 401 "$(status "$ORIGIN/api/files?password=$APP_TOKEN")"
	check 'app token cannot delete through the operator route' 401 \
		"$(status -X DELETE "$ORIGIN/api/delete-file?password=$APP_TOKEN&file=$APP_TOKEN_PREFIX/$PREFIX/in-scope.js")"
	check 'an unknown token is 401, not 403' 401 "$(put_as 'definitely-not-a-token' "$APP_TOKEN_PREFIX/$PREFIX/nope.js" 'x')"
	check 'public GET of an app-written object needs no token' 200 "$(status "$ORIGIN/$APP_TOKEN_PREFIX/$PREFIX/in-scope.js")"
	curl -sS -o /dev/null -X DELETE "$ORIGIN/api/delete-file?password=$UPLOAD_PASSWORD&file=$APP_TOKEN_PREFIX/$PREFIX/in-scope.js"
fi

echo
echo "== Cache tags and admin pages =="
check 'public GET carries the client and per-key cache tags' "dxd-cdn:$PREFIX,dxd-cdn-key:$PREFIX%2Fapp%2Fprod%2Fconfig.js" \
	"$(header cache-tag "$ORIGIN/$PREFIX/app/prod/config.js")"
check '/browse is no-store' 'private, no-store' "$(header cache-control "$ORIGIN/browse")"
check '/upload is no-store' 'private, no-store' "$(header cache-control "$ORIGIN/upload")"
check '/convert is no-store' 'private, no-store' "$(header cache-control "$ORIGIN/convert")"
check '/speed-test is no-store' 'private, no-store' "$(header cache-control "$ORIGIN/speed-test")"

echo
echo "== Browse / upload =="
check 'GET /browse without the password' 200 "$(status "$ORIGIN/browse")"
check 'GET /api/files with the password' 200 "$(status "$ORIGIN/api/files?password=$UPLOAD_PASSWORD")"
check 'GET /api/files without the password' 401 "$(status "$ORIGIN/api/files")"

echo
echo "== Cleanup =="
for key in "$PREFIX/app/prod/config.js" "$PREFIX/v1.2.3/bundle.js"; do
	curl -sS -o /dev/null -X DELETE "$ORIGIN/api/delete-file?password=$UPLOAD_PASSWORD&file=$key"
done

echo
echo "$PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
