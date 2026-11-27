"""Collect public KGS exchange rates without credentials."""
import json
import sys
from datetime import date, datetime, timezone
from decimal import Decimal, DecimalException
from html.parser import HTMLParser
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.request import Request, urlopen
from xml.etree import ElementTree


CBR = "https://www.cbr.ru/scripts/XML_daily.asp"
CBR_MIRROR = "https://www.cbr-xml-daily.ru/daily.xml"
MBANK = "https://mbank.kg/exchange_rates"
DATA = Path(__file__).with_name("data.json")
MAX_RESPONSE_SIZE = 2_000_000


def download(url):
    request = Request(url, headers={"User-Agent": "PultUpravleniya/1.0"})
    with urlopen(request, timeout=15) as response:
        content = response.read(MAX_RESPONSE_SIZE + 1)
    if len(content) > MAX_RESPONSE_SIZE:
        raise ValueError("Ответ источника слишком большой")
    return content


def positive_rate(value):
    rate = Decimal(value.replace(",", "."))
    if not rate.is_finite() or not Decimal("0.000001") <= rate <= Decimal("1000000"):
        raise ValueError("Источник вернул неверный курс")
    return rate


def parse_cbr(data):
    root = ElementTree.fromstring(data)
    quote = next((row for row in root.findall("Valute") if row.findtext("CharCode") == "KGS"), None)
    if quote is None:
        raise ValueError("Курс KGS отсутствует в данных Банка России")
    nominal = int(quote.findtext("Nominal", "0"))
    if nominal < 1:
        raise ValueError("Банк России вернул неверный номинал")
    amount = positive_rate(quote.findtext("Value", "")) / nominal
    return {
        "effective_on": datetime.strptime(root.attrib["Date"], "%d.%m.%Y").date().isoformat(),
        "rate": float(amount),
    }


class ExchangePageParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.reading = False
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag == "script" and dict(attrs).get("id") == "__NEXT_DATA__":
            self.reading = True

    def handle_data(self, data):
        if self.reading:
            self.parts.append(data)

    def handle_endtag(self, tag):
        if tag == "script":
            self.reading = False


def parse_mbank(data):
    parser = ExchangePageParser()
    parser.feed(data.decode("utf-8"))
    if not parser.parts:
        raise ValueError("MBANK не вернул публичную таблицу в ожидаемом формате")
    page = json.loads("".join(parser.parts))["props"]["pageProps"]["exchangePage"]
    operation_types = {
        "Для операций с наличными": "cash",
        "Безналичные курсы": "cashless",
    }
    rates = {}
    for table in page["cash_exchange"]:
        label = operation_types.get(table["operation_type"])
        if not label:
            continue
        rub = next((row for row in table["values"] if row.get("currency") == "RUB"), None)
        if rub is None or label in rates:
            raise ValueError(f"Таблица MBANK не содержит однозначный курс RUB ({label})")
        buy_rub = positive_rate(rub["buy"])
        sell_rub = positive_rate(rub["sell"])
        effective = datetime.fromisoformat(table["actual_from"])
        if sell_rub < buy_rub or effective.utcoffset() is None:
            raise ValueError("MBANK вернул некорректные данные курса")
        # The bank quotes KGS per RUB. Buying KGS means the bank buys RUB.
        rates[label] = {
            "effective_at": effective.isoformat(),
            "buy_som": float(1 / buy_rub),
            "sell_som": float(1 / sell_rub),
        }
    if set(rates) != set(operation_types.values()):
        raise ValueError("В таблице MBANK нет обоих курсов RUB")
    return rates


SOURCE_ERRORS = (OSError, ValueError, KeyError, TypeError, DecimalException, ElementTree.ParseError)


def collect():
    try:
        cbr = parse_cbr(download(CBR))
        cbr["url"] = CBR
    except SOURCE_ERRORS as error:
        print(f"Банк России: {error}. Проверяем зеркало публичного XML.", file=sys.stderr)
        cbr = parse_cbr(download(CBR_MIRROR))
        if date.fromisoformat(cbr["effective_on"]) < datetime.now(timezone.utc).date():
            raise ValueError("Зеркало Банка России вернуло устаревший курс")
        cbr["url"] = CBR_MIRROR
    mbank_rates = parse_mbank(download(MBANK))
    return {
        "version": 1,
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "cbr": cbr,
        "mbank": mbank_rates,
    }


def write_snapshot(path, snapshot):
    temporary = None
    try:
        with NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as output:
            temporary = Path(output.name)
            json.dump(snapshot, output, ensure_ascii=False, indent=2)
            output.write("\n")
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main():
    try:
        snapshot = collect()
        write_snapshot(DATA, snapshot)
    except SOURCE_ERRORS as error:
        print(f"Снимок не обновлён. Сохранён предыдущий data.json. Причина: {error}", file=sys.stderr)
        return 1
    print("Публичные курсы сома обновлены:", snapshot["updated_at"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
