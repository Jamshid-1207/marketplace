#!/bin/sh
# Создаёт недостающие топики из topics.conf и выравнивает retention у существующих.
# Падает, если у существующего топика другое число партиций (ADR-0002, п. 3).
# Состояние кластера читается одним describe: каждый запуск утилиты Kafka — это старт JVM,
# а kafka-init перезапускается при каждом `docker compose start` сервиса.
set -eu

BIN=/opt/kafka/bin
BOOTSTRAP="${BOOTSTRAP:-kafka:29092}"
CONF=/topics/topics.conf

# строки-заголовки топиков: "Topic: <имя> TopicId: … PartitionCount: N … Configs: retention.ms=…"
summary="$("$BIN/kafka-topics.sh" --bootstrap-server "$BOOTSTRAP" --describe --exclude-internal |
  grep '^Topic:' || true)"

grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$CONF" | while read -r name partitions retention; do
  line="$(echo "$summary" | awk -v t="$name" '$1 == "Topic:" && $2 == t')"
  if [ -z "$line" ]; then
    "$BIN/kafka-topics.sh" --bootstrap-server "$BOOTSTRAP" --create --if-not-exists --topic "$name" \
      --partitions "$partitions" --replication-factor 1 --config "retention.ms=$retention"
    continue
  fi
  actual="$(echo "$line" | sed -n 's/.*PartitionCount: *\([0-9][0-9]*\).*/\1/p')"
  if [ "$actual" != "$partitions" ]; then
    echo "kafka-init: у $name $actual партиций, в topics.conf $partitions." \
      "Число партиций не меняется — только миграция в новый топик" >&2
    exit 1
  fi
  current="$(echo "$line" | sed -n 's/.*retention\.ms=\(-\{0,1\}[0-9][0-9]*\).*/\1/p')"
  if [ "$current" != "$retention" ]; then
    "$BIN/kafka-configs.sh" --bootstrap-server "$BOOTSTRAP" --alter \
      --entity-type topics --entity-name "$name" --add-config "retention.ms=$retention" >/dev/null
    echo "kafka-init: $name retention.ms=$retention"
  else
    echo "kafka-init: $name ok"
  fi
done
