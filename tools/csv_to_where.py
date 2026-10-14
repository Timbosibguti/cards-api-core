#!/usr/bin/env python3
#
# Скрипт читает CSV-файл, извлекает значения из указанного номера столбца
# и формирует SQL-фильтр вида:
#   column_name IN (value1, value2, 'value3')
#
# Особенности:
# - использует только стандартную библиотеку Python;
# - строковые значения заключает в апострофы;
# - экранирует одиночные апострофы внутри строк;
# - может пропускать заголовок CSV;
# - может удалять дубликаты с сохранением порядка.
#
# Пример вызова:
#   python3 csv_to_where.py data.csv 2 --column-name user_id --skip-header
#   python3 csv_to_where.py data.csv 1 --column-name email --skip-header --unique

import argparse
import csv
import sys
from pathlib import Path


def sql_literal(value: str) -> str:
    value = value.strip()
    if value == "":
        return "''"

    try:
        int(value)
        return value
    except ValueError:
        pass

    try:
        float(value)
        return value
    except ValueError:
        pass

    escaped = value.replace("'", "''")
    return f"'{escaped}'"


def read_column_values(
    file_path: Path,
    column_index: int,
    delimiter: str,
    encoding: str,
    skip_header: bool,
) -> list[str]:
    values = []

    with file_path.open("r", encoding=encoding, newline="") as csv_file:
        reader = csv.reader(csv_file, delimiter=delimiter)

        if skip_header:
            next(reader, None)

        for row_number, row in enumerate(reader, start=2 if skip_header else 1):
            if column_index >= len(row):
                print(
                    f"Warning: row {row_number} has no column {column_index}",
                    file=sys.stderr,
                )
                continue

            raw_value = row[column_index].strip()
            if raw_value == "":
                continue

            values.append(raw_value)

    return values


def build_where_clause(column_name: str, values: list[str]) -> str:
    if not values:
        return f"{column_name} IN ()"

    literals = ", ".join(sql_literal(value) for value in values)
    return f"{column_name} IN ({literals})"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Convert a CSV column into a SQL WHERE IN filter."
    )
    parser.add_argument("csv_file", help="Path to the CSV file")
    parser.add_argument(
        "column_index",
        type=int,
        help="Zero-based CSV column index to extract",
    )
    parser.add_argument(
        "--column-name",
        default="column_name",
        help="SQL column name for the WHERE clause",
    )
    parser.add_argument(
        "--delimiter",
        default=",",
        help="CSV delimiter (default: ,)",
    )
    parser.add_argument(
        "--encoding",
        default="utf-8",
        help="File encoding (default: utf-8)",
    )
    parser.add_argument(
        "--skip-header",
        action="store_true",
        help="Skip the first CSV row",
    )
    parser.add_argument(
        "--unique",
        action="store_true",
        help="Keep only unique values while preserving order",
    )

    args = parser.parse_args()
    file_path = Path(args.csv_file)

    if not file_path.is_file():
        print(f"Error: file not found: {file_path}", file=sys.stderr)
        return 1

    if args.column_index < 0:
        print("Error: column_index must be >= 0", file=sys.stderr)
        return 1

    values = read_column_values(
        file_path=file_path,
        column_index=args.column_index,
        delimiter=args.delimiter,
        encoding=args.encoding,
        skip_header=args.skip_header,
    )

    if args.unique:
        values = list(dict.fromkeys(values))

    print(build_where_clause(args.column_name, values))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
