#!/bin/bash
# Chamado pelo gammu-smsd (RunOnReceive) quando chega um SMS.
# Ele monta o texto completo (inclusive SMS longos/concatenados) e
# repassa para o app Node via HTTP local.

PORT="${HTTP_PORT:-3000}"

# Número de quem enviou o SMS
NUMBER="${SMS_1_NUMBER}"

# Monta o texto. SMS longos viram várias partes; o gammu pode entregar
# o texto já remontado em DECODED_*; caso contrário concatenamos SMS_*.
TEXT=""
if [ -n "$DECODED_PARTS" ] && [ "$DECODED_PARTS" -gt 0 ] 2>/dev/null; then
  for i in $(seq 1 "$DECODED_PARTS"); do
    VAR="DECODED_${i}_TEXT"
    TEXT="${TEXT}${!VAR}"
  done
else
  COUNT="${SMS_MESSAGES:-1}"
  for i in $(seq 1 "$COUNT"); do
    VAR="SMS_${i}_TEXT"
    TEXT="${TEXT}${!VAR}"
  done
fi

curl -s -m 15 -X POST "http://127.0.0.1:${PORT}/sms-in" \
  --data-urlencode "from=${NUMBER}" \
  --data-urlencode "text=${TEXT}" > /dev/null 2>&1

exit 0
