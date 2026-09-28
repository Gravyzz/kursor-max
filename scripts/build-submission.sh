#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "Использование: $0 ПРЕЗЕНТАЦИЯ.pdf URL_РЕПОЗИТОРИЯ COMMIT_HASH REVIEW-ACCESS.txt" >&2
  exit 2
fi

presentation=$1
repository=$2
commit=$3
access_file=$4
root=$(cd "$(dirname "$0")/.." && pwd)
output_dir="$root/release"
output="$output_dir/Хакатон MAX - Образовательные решения - SQUAD 70.zip"

if [ ! -f "$presentation" ]; then
  echo "Не найдена презентация: $presentation" >&2
  exit 1
fi
if [ "${presentation##*.}" != "pdf" ] && [ "${presentation##*.}" != "PDF" ]; then
  echo "Презентация должна быть в PDF" >&2
  exit 1
fi
if [ ! -f "$access_file" ]; then
  echo "Не найден закрытый файл доступа: $access_file" >&2
  exit 1
fi
if ! grep -q '^X-Review-Key: .' "$access_file"; then
  echo "В REVIEW-ACCESS.txt должна быть строка X-Review-Key: <значение>" >&2
  exit 1
fi
if ! printf '%s' "$repository" | grep -Eq '^https://github\.com/[^/]+/[^/]+/?$'; then
  echo "Нужна ссылка на публичный репозиторий GitHub" >&2
  exit 1
fi
if ! printf '%s' "$commit" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "Нужен полный commit hash из 40 шестнадцатеричных символов" >&2
  exit 1
fi

for file in openapi.yaml DATA-API.yaml test-data.json; do
  if [ ! -f "$root/$file" ]; then
    echo "Не найден обязательный файл $file" >&2
    exit 1
  fi
done
command -v zip >/dev/null 2>&1 || { echo "Не найдена команда zip" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "Не найдена команда git" >&2; exit 1; }
command -v shasum >/dev/null 2>&1 || { echo "Не найдена команда shasum" >&2; exit 1; }

actual_commit=$(git -C "$root" rev-parse HEAD)
if [ "$actual_commit" != "$commit" ]; then
  echo "Переданный commit hash не совпадает с HEAD: $actual_commit" >&2
  exit 1
fi
if [ -n "$(git -C "$root" status --porcelain)" ]; then
  echo "Перед сборкой комплекта зафиксируйте все изменения в Git" >&2
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp "$presentation" "$tmp/Kursor-SQUAD70.pdf"
cp "$root/openapi.yaml" "$root/DATA-API.yaml" "$root/test-data.json" "$tmp/"
cp "$access_file" "$tmp/REVIEW-ACCESS.txt"
git -C "$root" archive --format=zip --output="$tmp/source-code.zip" "$commit"

cat > "$tmp/README.txt" <<EOF
Курсор — конструктор справочников для факультетов в MAX
Команда: SQUAD 70

Бот: https://max.ru/t753_hakaton_max_bot?start=demo
Стенд: https://kursor.139-100-236-88.sslip.io
Репозиторий: $repository
Commit: $commit

Основная проверка:
1. Открыть бота и выбрать роль «Деканат».
2. Открыть справочник, найти «справка», отметить пункт чек-листа.
3. Открыть редактор, создать раздел и страницу, опубликовать её.
4. Для API взять X-Review-Key из REVIEW-ACCESS.txt и выполнить шаги DATA-API.yaml.

Все данные демо модельные. Повторный POST /api/demo создаёт чистую песочницу.
EOF

(cd "$tmp" && shasum -a 256 Kursor-SQUAD70.pdf source-code.zip openapi.yaml DATA-API.yaml test-data.json README.txt > SHA256SUMS.txt)

mkdir -p "$output_dir"
rm -f "$output"
(cd "$tmp" && zip -qr "$output" .)

size=$(wc -c < "$output" | tr -d ' ')
if [ "$size" -gt 18000000 ]; then
  rm -f "$output"
  echo "Архив больше лимита 18 МБ: $size байт" >&2
  exit 1
fi

echo "Готово: $output ($size байт)"
