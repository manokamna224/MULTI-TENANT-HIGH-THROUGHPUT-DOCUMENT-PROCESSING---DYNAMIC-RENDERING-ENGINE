#!/usr/bin/env bash
# Generates self-signed dev certificates for the crypto-signing service.
# DO NOT use these in production — provision proper certs via your PKI.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Generating self-signed dev certificates in $SCRIPT_DIR ..."

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$SCRIPT_DIR/signing.key" \
  -out    "$SCRIPT_DIR/signing.crt" \
  -subj   "/C=IN/ST=Karnataka/L=Bangalore/O=DocEngine Dev/CN=docengine-dev-signer"

# Also export as PKCS#12 for the pkcs12 key source
openssl pkcs12 -export \
  -in     "$SCRIPT_DIR/signing.crt" \
  -inkey  "$SCRIPT_DIR/signing.key" \
  -out    "$SCRIPT_DIR/signing.p12" \
  -passout pass:devpassword

chmod 600 "$SCRIPT_DIR/signing.key" "$SCRIPT_DIR/signing.p12"
echo "Done. Files: signing.crt  signing.key  signing.p12 (pass: devpassword)"
