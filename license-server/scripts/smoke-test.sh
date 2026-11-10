#!/bin/bash
# Checks the live license service from outside. Creates one unpaid Stripe
# checkout session (expires on its own) to prove checkout works.
B="${1:-https://api.imali-defi.com/commander}"
code() { curl -s -o /dev/null -w '%{http_code}' -m 15 "$@"; }

echo "health:          $(curl -s -m 15 "$B/health")"
page=$(curl -s -m 15 "$B/buy")
echo "pricing page:    $(code "$B/buy")  shows \$9: $(grep -c '\$9' <<<"$page")  shows \$79: $(grep -c '\$79' <<<"$page")"
loc=$(curl -s -o /dev/null -m 20 -w '%{redirect_url}' "$B/buy?plan=monthly")
echo "checkout:        $(code "$B/buy?plan=monthly") -> ${loc%%/c/pay/*}/c/pay/… (live session: $(grep -c cs_live_ <<<"$loc"))"
echo "fake key:        $(code -X POST -H 'Content-Type: application/json' -d '{"key":"IMALI-AAAAA-AAAAA-AAAAA-AAAAA"}' "$B/v1/licenses/validate") (expect 404)"
echo "forged webhook:  $(code -X POST -H 'Stripe-Signature: t=1,v1=forged' -d '{}' "$B/v1/stripe/webhook") (expect 400)"
echo "manage page:     $(code "$B/manage")"
echo "sportsjedi API:  $(code https://api.sportsjedi.com/api/health)"
