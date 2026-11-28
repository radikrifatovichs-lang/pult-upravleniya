"use strict";

const byId = (id) => document.getElementById(id);
const DATA_KEY = "pult-upravleniya:demo:v1";
const SOURCE_KEY = "pult-upravleniya:sheet:v1";
const SHEET_SNAPSHOT_KEY = "pult-upravleniya:sheet-snapshot:v1";
const SALES_SNAPSHOT_KEY = "pult-upravleniya:sales-snapshot:v1";
const DAY = 86_400_000;
const ZONE = "Asia/Yekaterinburg";
const fields = ["revenue", "profit", "costs", "ads"];
const forecastDetails = ["commission", "cost"];
const RNP_FORMAT = "rnp-daily";
const RNP_PROFIT_ROW = 39;
// Dates, revenue after discount, margin after ads, ads, selling costs, commission, and cost of goods.
const RNP_SOURCE_ROWS = [2, 24, RNP_PROFIT_ROW, 51, 100, 95, 99];
const SALES_RANGE = "'Недельная динамика'!E9:U94";
const SALES_FIRST_ROW = 9;
const labels = {
  profit: "Прогнозируемая прибыль с учетом рекламы", revenue: "Выручка после СПП",
  costs: "Затраты", ads: "Реклама", commission: "Комиссия WB", cost: "Себестоимость",
};
const salesFields = {
  revenue: 12, commission: 18, ads: 27, penalties: 25, cost: 28, operations: 32, margin: 68, net: 94,
};
const dateFormat = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" });
const shortDate = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });
const clockFormat = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: ZONE });
const moneyFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const rateFormat = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 4, maximumFractionDigits: 6 });
const rateDateFormat = new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeZone: "UTC" });
const rateUpdateFormat = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "short", timeStyle: "short", timeZone: ZONE,
});
const RATES_CACHE = "pult-upravleniya:public-rates:v1";
const PUBLIC_RATES_URL = "https://raw.githubusercontent.com/radikrifatovichs-lang/pult-upravleniya/main/data.json";
const entryDialog = byId("entry-dialog");
const entryForm = byId("entry-form");
const sourceDialog = byId("source-dialog");
const sourceForm = byId("source-form");

let days = 1;
let salesDays = 1;
let editingDate = null;
let rows = [];
let googleRows = [];
let source = null;
let mode = "demo";
let googlePhase = "connect";
let googleMessage = "";
let lastRead = null;
let salesRows = [];
let salesReadAt = null;
let salesPhase = "connect";
let salesProblem = "";
let salesSaveFailed = false;
let authorization = null;
let requestNumber = 0;
let googleScript = null;
let loadingRates = false;
let ratesCheckedAt = 0;

function dateKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: ZONE,
  }).formatToParts(now);
  const part = (name) => parts.find(({ type }) => type === name).value;
  return [part("year"), part("month"), part("day")].join("-");
}

function shiftDate(key, offset) {
  return new Date(Date.parse(key) + offset * DAY).toISOString().slice(0, 10);
}

function yesterday() {
  return shiftDate(dateKey(), -1);
}

function periodLabel(start, end) {
  const last = dateFormat.format(new Date(end));
  return start === end ? last : dateFormat.format(new Date(start)) + " — " + last;
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && shiftDate(value, 0) === value;
}

function money(cents) {
  return cents === null ? "—" : moneyFormat.format(cents / 100) + "\u00a0₽";
}

function validRates(snapshot) {
  const isQuote = (value) => Number.isFinite(value) && value > 0;
  const isTable = (row) => typeof row?.effective_at === "string" && validDate(row.effective_at.slice(0, 10))
    && isQuote(row.buy_som) && isQuote(row.sell_som);
  return snapshot?.version === 1 && typeof snapshot.updated_at === "string"
    && Number.isFinite(Date.parse(snapshot.updated_at))
    && validDate(snapshot.cbr?.effective_on) && isQuote(snapshot.cbr.rate)
    && isTable(snapshot.mbank?.cash) && isTable(snapshot.mbank?.cashless);
}

function displayRates(snapshot, savedCopy) {
  const status = byId("rates-status");
  if (!snapshot) {
    status.textContent = "Курсы пока недоступны. Проверьте интернет и откройте приложение снова.";
    return;
  }
  const updated = new Date(snapshot.updated_at);
  const rate = (value) => rateFormat.format(value) + "\u00a0₽";
  byId("cbr-rate").textContent = rate(snapshot.cbr.rate);
  byId("cbr-date").textContent = "Курс на " + rateDateFormat.format(new Date(snapshot.cbr.effective_on));
  const effectiveDates = [];
  for (const [kind, title] of [["cash", "Наличные"], ["cashless", "Безналичные"]]) {
    const value = snapshot.mbank[kind];
    byId("mbank-" + kind).textContent = rate(value.buy_som) + " / " + rate(value.sell_som);
    effectiveDates.push([title, value.effective_at.slice(0, 10)]);
  }
  byId("mbank-date").textContent = effectiveDates[0][1] === effectiveDates[1][1]
    ? "Курс на " + rateDateFormat.format(new Date(effectiveDates[0][1]))
    : effectiveDates.map(([title, day]) => title + " — " + rateDateFormat.format(new Date(day))).join(" · ");
  status.textContent = (savedCopy ? "Сохранённая копия · " : "")
    + "Обновлено " + rateUpdateFormat.format(updated) + " (Екатеринбург)";
  byId("rates-values").hidden = false;
}

async function readRates(url) {
  const result = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(7000) });
  if (!result.ok) throw new Error("Не удалось загрузить файл курсов.");
  const rates = await result.json();
  if (!validRates(rates)) throw new Error("Файл курсов получен в неверном формате.");
  return rates;
}

async function loadRates() {
  if (loadingRates) return;
  if (location.protocol === "file:") {
    byId("rates-status").textContent = "Курсы доступны по ссылке на приложение.";
    return;
  }
  loadingRates = true;
  ratesCheckedAt = Date.now();
  let saved = null;
  try {
    const cached = JSON.parse(localStorage.getItem(RATES_CACHE));
    if (validRates(cached)) {
      saved = cached;
      displayRates(saved, true);
    }
  } catch {
    // Storage can be unavailable or have a damaged copy.
  }
  const site = location.origin === "https://radikrifatovichs-lang.github.io";
  try {
    if (!navigator.onLine && saved) return;
    if (!navigator.onLine && site) throw new Error("Нет сети.");
    const latest = new URL(site ? PUBLIC_RATES_URL : "./data.json", location.href);
    if (site) latest.searchParams.set("checked", String(Math.floor(Date.now() / 60_000)));
    const snapshot = await readRates(latest);
    if (saved && Date.parse(saved.updated_at) > Date.parse(snapshot.updated_at)) {
      displayRates(saved, true);
      return;
    }
    displayRates(snapshot, !navigator.onLine);
    try { localStorage.setItem(RATES_CACHE, JSON.stringify(snapshot)); }
    catch { /* The rates can still be displayed. */ }
  } catch {
    if (!saved && site) {
      try { saved = await readRates(new URL("./data.json", location.href)); }
      catch { /* Show an unavailable state below. */ }
    }
    displayRates(saved, true);
  } finally {
    loadingRates = false;
  }
}

function validatedRows(records, optionalFields = []) {
  if (!Array.isArray(records) || records.length > 10000) throw new Error("Список записей повреждён или слишком большой.");
  const dates = new Set();
  return records.map((record) => {
    if (!record || !validDate(record.date) || dates.has(record.date)) {
      throw new Error("В списке есть неверные или повторяющиеся даты.");
    }
    dates.add(record.date);
    const row = { date: record.date };
    for (const field of fields) {
      const value = record[field];
      if (!Number.isInteger(value) || Math.abs(value) > 100_000_000_000 || (field !== "profit" && value < 0)) {
        throw new Error("В списке есть неверные суммы.");
      }
      row[field] = value;
    }
    if (row.ads > row.costs) throw new Error("Реклама не может превышать общие затраты.");
    for (const field of optionalFields) {
      const value = record[field];
      row[field] = Number.isSafeInteger(value) ? value : null;
    }
    return row;
  });
}

function showNotice(message, error = false) {
  const notice = byId("notice");
  notice.textContent = message;
  notice.classList.toggle("error", error);
  notice.hidden = !message;
}

function readRows() {
  const raw = localStorage.getItem(DATA_KEY);
  return raw === null ? [] : validatedRows(JSON.parse(raw));
}

function persist(records) {
  try {
    const clean = validatedRows(records);
    localStorage.setItem(DATA_KEY, JSON.stringify(clean));
    rows = clean;
    render();
    return true;
  } catch (error) {
    showNotice(error.name === "QuotaExceededError" || error.name === "SecurityError"
      ? "Браузер не сохранил данные. Проверьте настройки хранения."
      : error.message, true);
    return false;
  }
}

function sourceText(count) {
  if (mode === "demo") return count || rows.length
    ? "Пробные данные · хранятся в этом браузере"
    : "Добавьте пробную запись или загрузите пример.";
  const snapshot = lastRead
    ? "Последняя загрузка: " + rateUpdateFormat.format(lastRead) + " (Екатеринбург). "
    : "";
  if (!navigator.onLine) return snapshot + "Нет интернета. Для обновления данных из Google Таблицы нужна сеть.";
  if (googlePhase === "ready") {
    return "Google Таблица · обновлено в " + clockFormat.format(lastRead) + " по Екатеринбургу";
  }
  return snapshot + googleMessage;
}

function updateChart(records, end) {
  const chart = byId("chart");
  const values = new Map(records.map(({ date, revenue }) => [date, revenue]));
  const series = Array.from({ length: 7 }, (_, index) => values.get(shiftDate(end, index - 6)));
  const highest = Math.max(1, ...series.map((value) => value ?? 0));
  const bars = series.map((value, index) => {
    const bar = document.createElement("span");
    const day = shortDate.format(new Date(shiftDate(end, index - 6)));
    bar.title = day + ": " + (value === undefined ? "нет данных" : money(value));
    if (value === undefined) bar.className = "missing";
    else bar.style.height = Math.max(3, value / highest * 100) + "%";
    return bar;
  });
  chart.replaceChildren(...bars);
  chart.setAttribute("aria-label", bars.map((bar) => bar.title).join(". "));
  const captions = [-6, -3, 0].map((offset) => {
    const caption = document.createElement("span");
    caption.textContent = shortDate.format(new Date(shiftDate(end, offset)));
    return caption;
  });
  byId("chart-labels").replaceChildren(...captions);
}

function renderRows(selected, useForecastDetails) {
  for (const header of document.querySelectorAll("#records-table [data-forecast-column]")) {
    header.hidden = (header.dataset.forecastColumn === "detail") !== useForecastDetails;
  }
  const columns = ["profit", "revenue", ...(useForecastDetails ? forecastDetails : ["costs", "ads"])];
  const rowElements = selected.map((record) => {
    const row = document.createElement("tr");
    row.dataset.date = record.date;
    row.insertCell().textContent = shortDate.format(new Date(record.date));
    for (const field of columns) {
      const cell = row.insertCell();
      cell.textContent = money(record[field] ?? null);
      cell.dataset.label = labels[field];
    }
    const actions = row.insertCell();
    actions.className = "row-actions";
    if (mode === "demo") {
      for (const [action, title] of [["edit", "Изменить"], ["delete", "Удалить"]]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "button button-quiet";
        button.dataset.action = action;
        button.textContent = title;
        button.setAttribute("aria-label", title + " запись за " + dateFormat.format(new Date(record.date)));
        actions.append(button);
      }
    }
    return row;
  });
  byId("records").replaceChildren(...rowElements);
}

function showSales(show) {
  byId("overview-panel").hidden = show;
  byId("sales-panel").hidden = !show;
  byId("show-overview").setAttribute("aria-pressed", String(!show));
  byId("show-sales").setAttribute("aria-pressed", String(show));
}

function renderSales(end) {
  const start = shiftDate(end, 1 - salesDays);
  const selected = salesRows.filter(({ date }) => date >= start && date <= end);
  byId("sales-period").textContent = periodLabel(start, end);
  for (const toggle of document.querySelectorAll("[data-sales-days]")) {
    toggle.setAttribute("aria-pressed", String(Number(toggle.dataset.salesDays) === salesDays));
  }
  const saved = salesReadAt
    ? "Последняя загрузка: " + rateUpdateFormat.format(salesReadAt) + " (Екатеринбург). "
    : "";
  let status;
  if (mode !== "google") status = "Подключите Google Таблицу в формате «Дневной (РНП)», чтобы увидеть продажи.";
  else if (source.format !== RNP_FORMAT) status = "Для продаж нужен формат таблицы «Дневной (РНП)».";
  else if (!navigator.onLine) status = saved + "Нет интернета.";
  else if (salesPhase === "loading") status = saved + "Загружаем продажи…";
  else if (salesPhase === "error") status = saved + salesProblem;
  else if (salesPhase === "ready") {
    status = "Недельная динамика · обновлено в " + clockFormat.format(salesReadAt) + " по Екатеринбургу.";
    if (!selected.length) status += " За этот период данных нет.";
  } else status = saved + "Для свежих цифр нажмите «Загрузить продажи», затем «Продолжить с Google».";
  if (salesSaveFailed) status += " Устройство не сохранило копию продаж.";
  byId("sales-status").textContent = status;
  const retry = byId("retry-sales");
  retry.hidden = mode !== "google" || source?.format !== RNP_FORMAT || !navigator.onLine
    || (salesPhase !== "error" && salesPhase !== "connect");
  retry.textContent = authorized() ? "Повторить" : "Загрузить продажи";

  for (const field of Object.keys(salesFields)) {
    const amounts = selected.map((row) => row[field]).filter(Number.isInteger);
    const count = amounts.length;
    byId("sales-" + field).textContent = money(count ? amounts.reduce((total, value) => total + value, 0) : null);
    const coverage = byId("sales-" + field + "-coverage");
    coverage.hidden = count === salesDays || (!count && !selected.length);
    coverage.textContent = "Дней с данными: " + count + " из " + salesDays;
  }
}

function render() {
  const end = yesterday();
  const start = shiftDate(end, 1 - days);
  const records = mode === "demo" ? rows : googleRows;
  const selected = records.filter(({ date }) => date >= start && date <= end)
    .sort((left, right) => right.date.localeCompare(left.date));
  const count = selected.length;
  const useForecastDetails = mode === "google" && source?.format === RNP_FORMAT;

  byId("period-label").textContent = periodLabel(start, end);
  for (const toggle of document.querySelectorAll("[data-days]")) {
    toggle.setAttribute("aria-pressed", String(Number(toggle.dataset.days) === days));
  }
  byId("source-status").textContent = sourceText(count);
  byId("retry").hidden = mode !== "google" || googlePhase !== "error";
  byId("return-demo").hidden = mode !== "google";
  byId("open-source").textContent = mode === "google" && googlePhase === "ready"
    ? "Настроить Google Таблицу" : "Подключить Google Таблицу";

  const gaps = [];
  for (const field of ["profit", "revenue", ...forecastDetails]) {
    const amounts = selected.map((row) => row[field]).filter(Number.isInteger);
    byId("metric-" + field).textContent = money(amounts.length ? amounts.reduce((total, value) => total + value, 0) : null);
    if (useForecastDetails && count && forecastDetails.includes(field) && amounts.length < days) {
      gaps.push(labels[field] + ": " + amounts.length + " из " + days + " дней");
    }
  }
  byId("metric-details").textContent = gaps.join(" · ");
  byId("metric-details").hidden = gaps.length === 0;
  const through = count ? " · по " + dateFormat.format(new Date(selected[0].date)) : "";
  byId("coverage").textContent = count === 0 ? "Нет данных за период"
    : count < days ? "Неполный итог · дней с данными: " + count + " из " + days + through
      : "Данные" + through;
  updateChart(records, end);

  byId("journal-note").textContent = mode === "demo" ? "Пробные данные хранятся в этом браузере."
    : source?.format === RNP_FORMAT
      ? "Данные из вкладки «Дневной (РНП)»."
      : "Данные читаются из Google Таблицы.";
  byId("entry-actions").hidden = mode !== "demo";
  byId("backup").hidden = mode !== "demo";
  byId("empty").hidden = count > 0;
  byId("empty-note").textContent = mode === "demo"
    ? "Загрузите выдуманный пример или добавьте пробную запись."
    : "Проверьте выбранный период и состояние подключения.";
  byId("records-table").hidden = count === 0;
  renderRows(selected, useForecastDetails);
  renderSales(end);
}

function exampleRows() {
  return Array.from({ length: 30 }, (_, index) => {
    const revenue = (index === 0 ? 126400 : 79500 + ((index * 8167) % 51000)) * 100;
    const costs = (index === 0 ? 92750 : 57900 + ((index * 5623) % 39000)) * 100;
    return {
      date: shiftDate(yesterday(), -index), revenue, costs,
      ads: (index === 0 ? 12400 : 6700 + ((index * 975) % 7000)) * 100,
      profit: revenue - costs,
    };
  });
}

function mergedRows(base, incoming) {
  return [...new Map([...base, ...incoming].map((row) => [row.date, row])).values()];
}

function editEntry(record) {
  editingDate = record?.date ?? null;
  entryForm.reset();
  byId("entry-title").textContent = record ? "Изменить запись" : "Добавить запись";
  byId("entry-error").textContent = "";
  entryForm.elements.date.max = yesterday();
  entryForm.elements.date.value = record?.date ?? yesterday();
  for (const field of fields) {
    entryForm.elements[field].value = record ? record[field] / 100 : "";
  }
  entryDialog.showModal();
}

function askConfirmation(title, message, action, callback) {
  const dialog = byId("confirm-dialog");
  const form = dialog.querySelector("form");
  byId("confirm-title").textContent = title;
  byId("confirm-text").textContent = message;
  byId("confirm-action").textContent = action;
  const submit = (event) => {
    event.preventDefault();
    if (event.submitter?.value === "confirm") callback();
    dialog.close();
  };
  form.addEventListener("submit", submit, { once: true });
  dialog.addEventListener("close", () => form.removeEventListener("submit", submit), { once: true });
  dialog.showModal();
}

entryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(entryForm);
  const date = data.get("date");
  const otherRows = rows.filter((record) => record.date !== editingDate);
  const record = { date };
  for (const field of fields) record[field] = Math.round(Number(data.get(field)) * 100);

  if (otherRows.some((row) => row.date === date)) {
    byId("entry-error").textContent = "Запись за эту дату уже есть. Измените её в списке.";
    return;
  }
  try {
    validatedRows([record]);
  } catch (error) {
    byId("entry-error").textContent = error.message;
    return;
  }
  const age = Math.round((Date.parse(yesterday()) - Date.parse(date)) / DAY) + 1;
  if (persist([...otherRows, record])) {
    if (age > days && age <= 30) days = age <= 7 ? 7 : 30;
    render();
    entryDialog.close();
    showNotice(age > 30 ? "Запись сохранена. Она за пределами последних 30 дней и входит в резервную копию." : "Запись сохранена.");
  }
});

byId("records").addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button || mode !== "demo") return;
  const date = button.closest("tr").dataset.date;
  if (button.dataset.action === "edit") {
    editEntry(rows.find((row) => row.date === date));
    return;
  }
  askConfirmation("Удалить запись?", "Запись за " + dateFormat.format(new Date(date)) + " будет удалена.", "Удалить запись", () => {
    if (persist(rows.filter((row) => row.date !== date))) showNotice("Запись удалена.");
  });
});

document.querySelectorAll("[data-days]").forEach((button) => {
  button.addEventListener("click", () => {
    days = Number(button.dataset.days);
    render();
  });
});
document.querySelectorAll("[data-close]").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});
byId("add-entry").addEventListener("click", () => editEntry());
byId("load-demo").addEventListener("click", () => {
  const added = mergedRows(exampleRows(), rows);
  if (persist(added)) showNotice("Пример загружен. Существующие записи сохранены.");
});

byId("download").addEventListener("click", () => {
  const json = JSON.stringify({ version: 1, records: rows }, null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "pult-upravleniya-" + dateKey() + ".json";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showNotice("Резервная копия скачивается.");
});

byId("upload").addEventListener("click", () => byId("backup-file").click());

byId("backup-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  let incoming;
  try {
    if (file.size > 4_000_000) throw new Error("Файл слишком большой.");
    const backup = JSON.parse(await file.text());
    if (backup?.version !== 1) throw new Error("Это не резервная копия «Пульта управления».");
    incoming = validatedRows(backup.records);
  } catch (error) {
    showNotice(error instanceof SyntaxError ? "Не удалось прочитать файл JSON." : error.message, true);
    return;
  }

  const apply = () => {
    if (persist(mergedRows(rows, incoming))) showNotice("Копия загружена. Записей в файле: " + incoming.length + ".");
  };
  if (incoming.some((entry) => rows.some((row) => row.date === entry.date))) {
    askConfirmation("Загрузить копию?", "Записи с совпадающими датами будут заменены версиями из файла.", "Загрузить", apply);
  } else {
    apply();
  }
});

function sheetDate(value) {
  if (typeof value === "number" && Number.isInteger(value)) return shiftDate("1899-12-30", value);
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value.trim());
  return match ? [match[3], match[2].padStart(2, "0"), match[1].padStart(2, "0")].join("-") : value.trim();
}

function parseSheet(values, optionalFields = []) {
  const records = [];
  let skipped = 0;
  for (const line of values) {
    if (line.every((cell) => cell === "")) continue;
    const cells = line.slice(1, 5);
    if (cells.length !== 4 || cells.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      skipped += 1;
      continue;
    }
    const record = { date: sheetDate(line[0]) };
    fields.forEach((field, index) => { record[field] = Math.round(cells[index] * 100); });
    optionalFields.forEach((field, index) => {
      const value = line[fields.length + 1 + index];
      record[field] = Number.isFinite(value) ? Math.round(value * 100) : null;
    });
    records.push(record);
  }
  return { records: validatedRows(records, optionalFields), skipped };
}

function parseRnpSheet(valueRanges) {
  if (valueRanges?.length !== RNP_SOURCE_ROWS.length) {
    throw new Error("Google Таблица вернула неполный набор показателей РНП.");
  }
  const [dates, revenue, profit, ads, sellingCosts, commission, cost] = valueRanges.map((range) => range.values?.[0] ?? []);
  const rows = dates.map((date, index) => {
    const adSpend = ads[index];
    const baseCost = sellingCosts[index];
    const total = Number.isFinite(adSpend) && Number.isFinite(baseCost) ? baseCost + adSpend : null;
    return date === "" || date == null ? [] : [date, revenue[index], profit[index], total, adSpend, commission[index], cost[index]];
  });
  return parseSheet(rows, forecastDetails);
}

function parseSalesSheet(rows) {
  const [starts = [], ends = []] = rows;
  const records = new Map();
  starts.forEach((value, index) => {
    const date = sheetDate(value);
    // The sheet also has period totals, which would duplicate daily amounts.
    if (!validDate(date) || date !== sheetDate(ends[index]) || records.has(date)) return;
    const record = { date };
    for (const [field, row] of Object.entries(salesFields)) {
      const amount = rows[row - SALES_FIRST_ROW]?.[index];
      record[field] = Number.isFinite(amount) ? Math.round(amount * 100) : null;
    }
    records.set(date, record);
  });
  return [...records.values()];
}

function googleStatus(phase, message) {
  googlePhase = phase;
  googleMessage = message;
  render();
}

function loadGoogleLibrary() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!googleScript) {
    googleScript = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      const fail = () => {
        clearTimeout(timeout);
        script.remove();
        googleScript = null;
        reject(new Error("Не удалось открыть окно Google. Проверьте подключение к интернету."));
      };
      const timeout = setTimeout(fail, 12000);
      script.onload = () => {
        if (!window.google?.accounts?.oauth2) return fail();
        clearTimeout(timeout);
        resolve();
      };
      script.onerror = fail;
      document.head.append(script);
    });
  }
  return googleScript;
}

function authorized() {
  return authorization && authorization.expires > Date.now();
}

function saveSourcePreference() {
  try {
    localStorage.setItem(SOURCE_KEY, JSON.stringify({ ...source, active: mode === "google" }));
  } catch {
    showNotice("Браузер не сохранил настройки подключения.", true);
  }
}

function sourceIdentity({ client, sheetId, format, range }) {
  const identity = [client, sheetId, format, range];
  // A saved RNP snapshot must use the current definition of profit.
  if (format === RNP_FORMAT) identity.push(RNP_PROFIT_ROW);
  return JSON.stringify(identity);
}

function readSheetSnapshot(key) {
  const snapshot = JSON.parse(localStorage.getItem(key));
  if (snapshot?.source !== sourceIdentity(source) || !Array.isArray(snapshot.records)) return null;
  const savedAt = new Date(snapshot.loadedAt);
  if (!snapshot.loadedAt || !Number.isFinite(savedAt.getTime())) return null;
  return { savedAt, records: snapshot.records };
}

function restoreSheetSnapshot() {
  const overview = readSheetSnapshot(SHEET_SNAPSHOT_KEY);
  if (overview) {
    googleRows = validatedRows(overview.records, source.format === RNP_FORMAT ? forecastDetails : []);
    lastRead = overview.savedAt;
  }
  const sales = readSheetSnapshot(SALES_SNAPSHOT_KEY);
  if (sales) {
    salesRows = sales.records.filter((row) => validDate(row?.date));
    salesReadAt = sales.savedAt;
  }
}

function saveSheetSnapshot(key, records, loadedAt, daysToKeep) {
  const latestDate = dateKey(loadedAt);
  const oldestDate = shiftDate(latestDate, -daysToKeep);
  localStorage.setItem(key, JSON.stringify({
    source: sourceIdentity(source),
    loadedAt: loadedAt.toISOString(),
    records: records.filter(({ date }) => date >= oldestDate && date <= latestDate),
  }));
}

function clearSheetSnapshot() {
  googleRows = [];
  lastRead = null;
  salesRows = [];
  salesReadAt = null;
  salesPhase = "connect";
  salesProblem = "";
  salesSaveFailed = false;
  try {
    localStorage.removeItem(SHEET_SNAPSHOT_KEY);
    localStorage.removeItem(SALES_SNAPSHOT_KEY);
  } catch {
    return false;
  }
  return true;
}

async function fetchSales(valuesUrl, request, token) {
  const url = new URL(valuesUrl + "/" + encodeURIComponent(SALES_RANGE));
  url.searchParams.set("valueRenderOption", "UNFORMATTED_VALUE");
  let httpStatus;
  try {
    const response = await fetch(url, {
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      httpStatus = response.status;
      throw new Error("Google Sheets request failed");
    }
    const values = await response.json();
    if (request !== requestNumber || mode !== "google") return;
    salesRows = parseSalesSheet(values.values ?? []);
    salesReadAt = new Date();
    salesPhase = "ready";
  } catch {
    if (request !== requestNumber || mode !== "google") return;
    salesPhase = "error";
    if (httpStatus === 401) {
      authorization = null;
      salesProblem = "Разрешение Google истекло. Нажмите «Загрузить продажи».";
    } else if (httpStatus === 403) {
      salesProblem = "Google не дал доступ к таблице. Проверьте, какой аккаунт Google подключён.";
    } else {
      salesProblem = "Не удалось прочитать «Недельную динамику»"
        + (httpStatus ? " (ошибка Google " + httpStatus + ")." : ". Проверьте интернет и попробуйте снова.");
    }
  }
  if (salesPhase === "ready") {
    salesSaveFailed = false;
    try {
      saveSheetSnapshot(SALES_SNAPSHOT_KEY, salesRows, salesReadAt, 7);
    } catch {
      salesSaveFailed = true;
    }
  }
  renderSales(yesterday());
}

async function refreshSheet() {
  if (!authorized()) {
    salesPhase = "connect";
    googleStatus("connect", "Для свежих цифр нажмите «Подключить Google Таблицу» → «Продолжить с Google».");
    return;
  }
  const request = ++requestNumber;
  const { sheetId, range, format } = source;
  const token = authorization.token;
  const rnp = format === RNP_FORMAT;
  const valuesUrl = "https://sheets.googleapis.com/v4/spreadsheets/" + sheetId + "/values";
  if (rnp) {
    salesPhase = "loading";
    void fetchSales(valuesUrl, request, token);
  }
  googleStatus("loading", "Загружаем данные из Google Таблицы…");
  try {
    const url = new URL(valuesUrl + (rnp ? ":batchGet" : "/" + encodeURIComponent(range)));
    url.searchParams.set("valueRenderOption", "UNFORMATTED_VALUE");
    if (rnp) {
      for (const row of RNP_SOURCE_ROWS) {
        url.searchParams.append("ranges", "'Дневной (РНП)'!S" + row + ":CB" + row);
      }
    }
    const response = await fetch(url, {
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(12000),
    });
    if (request !== requestNumber || mode !== "google") return;
    if (response.status === 401) {
      authorization = null;
      googleStatus("connect", "Разрешение Google истекло. Подключите таблицу снова.");
      return;
    }
    if (!response.ok) {
      const message = response.status === 403 ? "Google не дал доступ к таблице. Проверьте разрешение и выбранный аккаунт."
        : "Не удалось прочитать Google Таблицу. Проверьте ссылку, диапазон и подключение.";
      throw new Error(message);
    }
    const values = await response.json();
    const data = rnp ? parseRnpSheet(values.valueRanges) : parseSheet(values.values ?? []);
    if (request !== requestNumber || mode !== "google") return;
    googleRows = data.records;
    lastRead = new Date();
    try {
      saveSheetSnapshot(SHEET_SNAPSHOT_KEY, googleRows, lastRead, 30);
    } catch {
      googleStatus("ready", "");
      showNotice("Устройство не сохранило показатели для следующего запуска.", true);
      return;
    }
    googleStatus("ready", "");
    showNotice(data.skipped ? "Дней с неполными суммами пропущено: " + data.skipped + "." : "");
  } catch (error) {
    if (request === requestNumber && mode === "google") {
      googleStatus("error", error.name === "TimeoutError" || error instanceof TypeError
        ? "Google Таблица не ответила. Проверьте интернет и повторите попытку."
        : error.message);
    }
  }
}

function renderSourceFormat() {
  const rnp = sourceForm.elements.format.value === RNP_FORMAT;
  byId("source-range").hidden = rnp;
  sourceForm.elements.range.disabled = rnp;
  byId("source-format-note").textContent = rnp
    ? "Сводка читает вкладку «Дневной (РНП)», а продажи — «Недельную динамику»."
    : "Порядок столбцов: дата, выручка, прибыль, общие затраты, реклама. Суммы в рублях.";
}

function fillSheetSetup(settings) {
  sourceForm.elements.client.value = settings.client;
  sourceForm.elements.sheet.value = "https://docs.google.com/spreadsheets/d/" + settings.sheetId + "/edit";
  sourceForm.elements.format.value = settings.format ?? "rows";
  sourceForm.elements.range.value = settings.range ?? "";
  renderSourceFormat();
}

sourceForm.elements.format.addEventListener("change", renderSourceFormat);
function openSheetSetup(settings = source) {
  byId("source-error").textContent = "";
  byId("source-setup-status").textContent = "";
  sourceForm.elements.setup.value = "";
  if (settings) fillSheetSetup(settings);
  else renderSourceFormat();
  sourceDialog.showModal();
  const submit = sourceForm.querySelector("[type=submit]");
  submit.disabled = true;
  loadGoogleLibrary().then(() => { submit.disabled = false; }).catch((error) => {
    byId("source-error").textContent = error.message;
  });
}

function sheetSetupFromLink(url = new URL(location.href)) {
  const appRoot = new URL("./", location.href);
  if (url.origin !== appRoot.origin
    || (url.pathname !== appRoot.pathname && url.pathname !== new URL("index.html", appRoot).pathname)) {
    return null;
  }
  const parameters = new URLSearchParams(url.hash.slice(1));
  if (parameters.get("connect") !== "rnp") return null;
  const client = parameters.get("client") ?? "";
  const sheetId = parameters.get("sheet") ?? "";
  if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(client) || !/^[\w-]{1,128}$/.test(sheetId)) {
    return null;
  }
  return { client, sheetId, format: RNP_FORMAT };
}

byId("apply-setup-link").addEventListener("click", () => {
  let imported = null;
  const pasted = sourceForm.elements.setup.value;
  const address = pasted.match(/https?:\/\/[^\s<>"']+/i)?.[0];
  try {
    if (address) imported = sheetSetupFromLink(new URL(address));
  } catch {
    // The text was not a URL.
  }
  byId("source-setup-status").textContent = "";
  if (!imported) {
    byId("source-error").textContent = "Вставьте ссылку подключения «Пульта управления».";
    return;
  }
  byId("source-error").textContent = "";
  fillSheetSetup(imported);
  sourceForm.elements.setup.value = "";
  byId("source-setup-status").textContent = "Настройки подставлены. Нажмите «Продолжить с Google».";
});

byId("open-source").addEventListener("click", () => openSheetSetup());

sourceForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!window.google?.accounts?.oauth2) return;
  const input = new FormData(sourceForm);
  const client = input.get("client").trim();
  const sheetUrl = new URL(input.get("sheet").trim());
  const sheetId = /^\/spreadsheets\/d\/([\w-]+)(?:\/|$)/.exec(sheetUrl.pathname)?.[1];
  const format = input.get("format") === RNP_FORMAT ? RNP_FORMAT : "rows";
  const range = (input.get("range") ?? "").trim();
  if (sheetUrl.origin !== "https://docs.google.com" || !sheetId || (format !== RNP_FORMAT && !range.includes("!"))
      || !/^[\w-]+\.apps\.googleusercontent\.com$/.test(client)) {
    byId("source-error").textContent = "Проверьте ссылку, идентификатор Google и диапазон с названием вкладки.";
    return;
  }
  const pendingSource = { client, sheetId, range, format };
  const attempt = ++requestNumber;
  const submit = sourceForm.querySelector("[type=submit]");
  submit.disabled = true;
  byId("source-error").textContent = "";

  function fail() {
    submit.disabled = false;
    if (attempt === requestNumber && sourceDialog.open) {
      byId("source-error").textContent = "Google не выдал разрешение. Выберите аккаунт с доступом к таблице и повторите попытку.";
    }
  }

  try {
    window.google.accounts.oauth2.initTokenClient({
      client_id: client,
      scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
      error_callback: fail,
      callback: (response) => {
        if (attempt !== requestNumber || !sourceDialog.open) {
          submit.disabled = false;
          return;
        }
        if (!response.access_token) return fail();
        submit.disabled = false;
        if (!source || sourceIdentity(source) !== sourceIdentity(pendingSource)) clearSheetSnapshot();
        source = pendingSource;
        authorization = {
          token: response.access_token,
          expires: Date.now() + Math.max(0, Number(response.expires_in) - 15) * 1000,
        };
        mode = "google";
        saveSourcePreference();
        if (sheetSetupFromLink()) history.replaceState(history.state, "", location.pathname + location.search);
        sourceDialog.close();
        refreshSheet();
      },
    }).requestAccessToken();
  } catch {
    fail();
  }
});

byId("retry").addEventListener("click", refreshSheet);
byId("retry-sales").addEventListener("click", () => {
  if (authorized()) refreshSheet();
  else openSheetSetup();
});
byId("show-overview").addEventListener("click", () => showSales(false));
byId("show-sales").addEventListener("click", () => showSales(true));
document.querySelector(".brand").addEventListener("click", () => showSales(false));
for (const toggle of document.querySelectorAll("[data-sales-days]")) {
  toggle.addEventListener("click", () => {
    salesDays = Number(toggle.dataset.salesDays);
    renderSales(yesterday());
  });
}
byId("return-demo").addEventListener("click", () => {
  requestNumber += 1;
  const cleared = clearSheetSnapshot();
  authorization = null;
  mode = "demo";
  render();
  showNotice(cleared ? "" : "Не удалось удалить сохранённые рабочие показатели.", !cleared);
  saveSourcePreference();
});
window.addEventListener("focus", () => {
  if (Date.now() - ratesCheckedAt > 15 * 60_000) loadRates();
  if (mode === "google" && googlePhase === "ready"
    && (!authorized() || Date.now() - lastRead.getTime() > 60_000)) {
    refreshSheet();
  } else {
    render();
  }
});
window.addEventListener("storage", (event) => {
  if (event.key === DATA_KEY || event.key === null) {
    try {
      rows = readRows();
      render();
    } catch {
      showNotice("Не удалось прочитать сохранённые пробные записи.", true);
    }
  }
});
window.addEventListener("online", () => {
  render();
  loadRates();
});
window.addEventListener("offline", render);

try {
  rows = readRows();
  const saved = localStorage.getItem(SOURCE_KEY);
  if (saved) {
    source = JSON.parse(saved);
    if (source?.active) {
      mode = "google";
      googleMessage = "Для свежих цифр нажмите «Подключить Google Таблицу» → «Продолжить с Google».";
      restoreSheetSnapshot();
    }
  }
} catch {
  showNotice("Не удалось прочитать сохранённые записи или настройки.", true);
}
render();
loadRates();
const sheetSetup = sheetSetupFromLink();
if (sheetSetup) openSheetSetup(sheetSetup);

function waitForAppActivation(worker) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Activation timed out")), 20_000);
    function finish(error) {
      clearTimeout(timeout);
      worker.removeEventListener("statechange", onStateChange);
      if (error) reject(error);
      else resolve();
    }
    function onStateChange() {
      if (worker.state === "activated") finish();
      if (worker.state === "redundant") finish(new Error("App update was not installed"));
    }
    worker.addEventListener("statechange", onStateChange);
    onStateChange();
  });
}

if (location.protocol !== "file:" && "serviceWorker" in navigator) {
  const workers = navigator.serviceWorker;
  const pageWorker = workers.controller;
  const register = () => workers.register("./sw.js", { updateViaCache: "none" });
  register().catch((error) => {
    console.warn("Не удалось подготовить офлайн-версию приложения.", error);
  });

  const button = byId("update-app");
  const status = byId("app-update-status");
  button.hidden = false;
  button.addEventListener("click", async () => {
    if (!navigator.onLine) {
      status.textContent = "Нет интернета. Подключитесь к сети и попробуйте снова.";
      return;
    }
    button.disabled = true;
    status.textContent = "Проверяем обновление приложения…";
    try {
      const registration = await workers.getRegistration() ?? await register();
      await registration.update();
      const worker = registration.installing ?? registration.waiting ?? registration.active;
      if (!worker) throw new Error("No app version available");
      if (worker === pageWorker && worker.state === "activated") {
        status.textContent = "Установлена последняя версия приложения.";
        return;
      }
      await waitForAppActivation(worker);
      status.textContent = "Открываем новую версию…";
      location.reload();
    } catch {
      status.textContent = "Не удалось обновить приложение. Попробуйте ещё раз.";
    } finally {
      button.disabled = false;
    }
  });
}
