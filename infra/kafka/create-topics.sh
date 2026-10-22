#!/bin/sh
# Создаёт недостающие топики из topics.conf и выравнивает retention у существующих.
# Падает, если у существующего топика другое число партиций (ADR-0002, п. 3).
set -eu

BIN=/opt/kafka/bin
BOOTSTRAP="${BOOTSTRAP:-kafka:29092}"
CONF=/topics/topics.conf

existing="$("$BIN/kafka-topics.sh" --bootstrap-server "$BOOTSTRAP" --list)"

grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$CONF" | while read -r name partitions retention; do
  if echo "$existing" | grep -qxF "$name"; then
    actual="$("$BIN/kafka-topics.sh" --bootstrap-server "$BOOTSTRAP" --describe --topic "$name" |
      sed -n 's/.*PartitionCount: *\([0-9][0-9]*\).*/\1/p' | head -n 1)"
    if [ "$actual" != "$partitions" ]; then
      echo "kafka-init: у $name $actual партиций, в topics.conf $partitions." \
        "Число партиций не меняется — только миграция в новый топик" >&2
      exit 1
    fi
    "$BIN/kafka-configs.sh" --bootstrap-server "$BOOTSTRAP" --alter \
      --entity-type topics --entity-name "$name" --add-config "retention.ms=$retention" >/dev/null
    echo "kafka-init: $name ok"
  else
    "$BIN/kafka-topics.sh" --bootstrap-server "$BOOTSTRAP" --create --if-not-exists --topic "$name" \
      --partitions "$partitions" --replication-factor 1 --config "retention.ms=$retention"
  fi
done
