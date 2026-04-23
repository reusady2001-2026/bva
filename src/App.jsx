import { useState, useEffect } from "react";
import * as XLSX from "xlsx";

const API_URL = "/api/claude";
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY;

const C = {
  bg: "#0f1117", card: "#1a1d27", border: "#2a2d3a",
  accent: "#6366f1", green: "#22c55e", red: "#ef4444",
  yellow: "#f59e0b", muted: "#6b7280", text: "#f1f5f9", sub: "#94a3b8",
};

const MONTHS = ["ינואר","פברואר","מרץ","אפריל","מאי","יוני","יולי","אוגוסט","ספטמבר","אוקטובר","נובמבר","דצמבר"];

// ── Supabase helpers ──────────────────────────────────────────────
async function sbFetch(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: opts.prefer || "",
    },
    ...opts,
  });
  if (!res.ok) throw new Error(await res.text());
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

async function getOrCreateProperty(name) {
  const rows = await sbFetch(`/bva_properties?name=eq.${encodeURIComponent(name)}&select=id`);
  if (rows?.length) return rows[0].id;
  const created = await sbFetch("/bva_properties", {
    method: "POST", prefer: "return=representation",
    body: JSON.stringify({ name }),
  });
  return created[0].id;
}

async function upsertRows(table, rows) {
  if (!rows.length) return;
  await sbFetch(`/${table}?on_conflict=property_id,year,month,category`, {
    method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
    body: JSON.stringify(rows),
  });
}

async function loadProperties() {
  return await sbFetch("/bva_properties?select=id,name&order=name");
}

async function loadMonths(table, propertyId) {
  const rows = await sbFetch(`/${table}?property_id=eq.${propertyId}&select=year,month`);
  const seen = new Set();
  return rows.filter(r => { const k = `${r.year}-${r.month}`; if (seen.has(k)) return false; seen.add(k); return true; })
             .sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month);
}

async function loadData(table, propertyId, year, month) {
  return await sbFetch(`/${table}?property_id=eq.${propertyId}&year=eq.${year}&month=eq.${month}&select=category,section,value`);
}

// ── Claude helpers ────────────────────────────────────────────────
async function getInsights(matches) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 16000,
      messages: [{
        role: "user",
        content: `אתה אנליסט נדל"ן. נתח את ה-BVA הבא ותן 3-5 תובנות קצרות בעברית. היה ספציפי עם מספרים.\n\n${JSON.stringify(matches)}`,
      }],
    }),
  });
  const data = await res.json();
  return data.content?.map(b => b.text || "").join("") || "";
}

// ── File parsing ──────────────────────────────────────────────────
async function readFileCSV(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => {
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      res(XLSX.utils.sheet_to_csv(sheet));
    };
    r.onerror = rej;
    r.readAsArrayBuffer(file);
  });
}

// ── UI Components ─────────────────────────────────────────────────
function Btn({ children, onClick, disabled, small, danger, outline }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: small ? "6px 14px" : "11px 20px",
      borderRadius: 8, border: outline ? `1px solid ${C.border}` : "none",
      background: disabled ? C.border : danger ? C.red : outline ? "transparent" : C.accent,
      color: "#fff", fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer",
      fontSize: small ? 12 : 14, opacity: disabled ? 0.5 : 1,
    }}>{children}</button>
  );
}

function DropZone({ label, file, onFile, accept = ".xlsx,.xls,.csv" }) {
  return (
    <div onClick={() => document.getElementById(`dz-${label}`).click()}
      onDragOver={e => e.preventDefault()}
      onDrop={e => { e.preventDefault(); onFile(e.dataTransfer.files[0]); }}
      style={{
        border: `2px dashed ${file ? C.accent : C.border}`, borderRadius: 10,
        padding: "20px 16px", textAlign: "center", cursor: "pointer",
        background: file ? "#1e2035" : C.card, flex: 1,
      }}>
      <input id={`dz-${label}`} type="file" accept={accept} style={{ display: "none" }}
        onChange={e => onFile(e.target.files[0])} />
      <div style={{ fontSize: 22, marginBottom: 6 }}>{file ? "✅" : "📂"}</div>
      <div style={{ color: file ? C.accent : C.sub, fontWeight: 600, fontSize: 13 }}>
        {file ? file.name : label}
      </div>
      {!file && <div style={{ color: C.muted, fontSize: 11, marginTop: 3 }}>Excel / CSV — גרור או לחץ</div>}
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────
export default function BVATool() {
  const [view, setView] = useState("home"); // home | property | upload | analyze
  const [properties, setProperties] = useState([]);
  const [activeProperty, setActiveProperty] = useState(null);
  const [newPropName, setNewPropName] = useState("");
  const [budgetMonths, setBudgetMonths] = useState([]);
  const [actualMonths, setActualMonths] = useState([]);

  // Upload state
  const [uploadType, setUploadType] = useState("budget"); // budget | actual
  const [uploadFile, setUploadFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState("");
  const [uploadResult, setUploadResult] = useState(null);

  // Analyze state
  const [selMonths, setSelMonths] = useState([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [bvaData, setBvaData] = useState(null);
  const [insights, setInsights] = useState(null);
  const [insightLoading, setInsightLoading] = useState(false);

  useEffect(() => { fetchProperties(); }, []);

  async function fetchProperties() {
    try { setProperties(await loadProperties()); } catch {}
  }

  async function openProperty(prop) {
    setActiveProperty(prop);
    setBvaData(null); setInsights(null);
    const [bm, am] = await Promise.all([
      loadMonths("bva_budget", prop.id).catch(() => []),
      loadMonths("bva_actual", prop.id).catch(() => []),
    ]);
    setBudgetMonths(bm); setActualMonths(am);
    setView("property");
  }

  async function createProperty() {
    if (!newPropName.trim()) return;
    try {
      await getOrCreateProperty(newPropName.trim());
      setNewPropName("");
      await fetchProperties();
    } catch (e) { alert("שגיאה: " + e.message); }
  }

  async function handleUpload() {
    if (!uploadFile || !activeProperty) return;
    setUploading(true); setUploadMsg("קורא קובץ..."); setUploadResult(null);
    try {
      const buffer = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(new Uint8Array(e.target.result));
        reader.onerror = reject;
        reader.readAsArrayBuffer(uploadFile);
      });
      const wb = XLSX.read(buffer, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

      const currentYear = new Date().getFullYear();
      const HEBREW_MONTHS = ["ינואר","פברואר","מרץ","אפריל","מאי","יוני","יולי","אוגוסט","ספטמבר","אוקטובר","נובמבר","דצמבר"];

      function parseMonthCell(h) {
        if (!h) return null;
        const s = String(h).trim();
        if (!s || s.toLowerCase() === "total") return null;
        // Hebrew month name (with optional year)
        const hebrewIdx = HEBREW_MONTHS.indexOf(s);
        if (hebrewIdx !== -1) return { month: hebrewIdx + 1, year: currentYear };
        // MM/YYYY
        const mmYYYY = s.match(/^(\d{1,2})\/(\d{4})$/);
        if (mmYYYY) return { month: parseInt(mmYYYY[1]), year: parseInt(mmYYYY[2]) };
        // "MMM YYYY" e.g. "Apr 2024"
        const mmmYYYY = s.match(/^([A-Za-z]{3,9})\s+(\d{4})$/);
        if (mmmYYYY) {
          const d = new Date(`${mmmYYYY[1]} 1 ${mmmYYYY[2]}`);
          if (!isNaN(d)) return { month: d.getMonth() + 1, year: parseInt(mmmYYYY[2]) };
        }
        return null;
      }

      // Find the header row: first row where any cell from index 1 onward parses as a month
      let headerRowIndex = -1;
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r] || [];
        for (let c = 1; c < row.length; c++) {
          if (parseMonthCell(row[c])) { headerRowIndex = r; break; }
        }
        if (headerRowIndex !== -1) break;
      }
      if (headerRowIndex === -1) throw new Error("לא נמצאה שורת כותרת עם עמודות חודש בקובץ");

      const propertyName = headerRowIndex > 0 ? String(rows[0]?.[0] ?? "").trim() || null : null;
      const headers = rows[headerRowIndex] || [];

      const monthCols = [];
      for (let c = 1; c < headers.length; c++) {
        const parsed = parseMonthCell(headers[c]);
        if (parsed) monthCols.push({ col: c, month: parsed.month, year: parsed.year });
      }

      if (monthCols.length === 0) throw new Error("לא נמצאו עמודות חודש בקובץ");

      const monthData = {};
      for (const mc of monthCols) monthData[`${mc.year}-${mc.month}`] = { year: mc.year, month: mc.month, items: [] };

      for (let r = headerRowIndex + 1; r < rows.length; r++) {
        const row = rows[r];
        const category = String(row?.[0] ?? "").trim();
        if (!category) continue;
        const section = "Other";
        for (const mc of monthCols) {
          const raw = String(row[mc.col] ?? "").replace(/[$,]/g, "").trim();
          const value = parseFloat(raw);
          monthData[`${mc.year}-${mc.month}`].items.push({ category, section, value: isNaN(value) ? 0 : value });
        }
      }

      setUploadMsg(`שומר ${monthCols.length} חודש/ים...`);
      const table = uploadType === "budget" ? "bva_budget" : "bva_actual";
      let saved = 0;
      for (const key of Object.keys(monthData)) {
        const m = monthData[key];
        if (!m.items.length) continue;
        const deduped = [...new Map(m.items.map(i => [i.category, i])).values()];
        await upsertRows(table, deduped.map(item => ({
          property_id: activeProperty.id,
          year: m.year, month: m.month,
          category: item.category, section: item.section, value: item.value,
          updated_at: new Date().toISOString(),
        })));
        saved++;
      }

      setUploadResult({ ok: true, months: saved });
      setUploadFile(null);
      const [bm, am] = await Promise.all([
        loadMonths("bva_budget", activeProperty.id).catch(() => []),
        loadMonths("bva_actual", activeProperty.id).catch(() => []),
      ]);
      setBudgetMonths(bm); setActualMonths(am);
    } catch (e) {
      setUploadResult({ ok: false, msg: e.message });
    } finally { setUploading(false); setUploadMsg(""); }
  }

  async function runAnalysis() {
    if (!selMonths.length || !activeProperty) return;
    setAnalyzing(true); setBvaData(null); setInsights(null);
    try {
      const allRows = [];
      for (const { year, month } of selMonths) {
        const [budgetRows, actualRows] = await Promise.all([
          loadData("bva_budget", activeProperty.id, year, month),
          loadData("bva_actual", activeProperty.id, year, month),
        ]);
        const budgetMap = Object.fromEntries(budgetRows.map(r => [r.category, r]));
        const actualMap = Object.fromEntries(actualRows.map(r => [r.category, r]));
        const allCats = [...new Set([...Object.keys(budgetMap), ...Object.keys(actualMap)])];
        for (const cat of allCats) {
          allRows.push({
            category: cat,
            section: budgetMap[cat]?.section || actualMap[cat]?.section || "Other",
            budget: budgetMap[cat]?.value ?? 0,
            actual: actualMap[cat]?.value ?? 0,
            year,
            month,
          });
        }
      }
      setBvaData(allRows);
    } catch (e) { alert("שגיאה: " + e.message); }
    finally { setAnalyzing(false); }
  }

  // Available months for analysis (intersection of budget + actual)
  const budgetKeys = new Set(budgetMonths.map(m => `${m.year}-${m.month}`));
  const commonMonths = actualMonths.filter(m => budgetKeys.has(`${m.year}-${m.month}`));

  const sections = bvaData ? ["Income","Expense","NOI","Other"].filter(s => bvaData.some(r => r.section === s)) : [];
  const totalBudget = bvaData ? bvaData.filter(r=>r.section==="Income").reduce((a,b)=>a+b.budget,0) - bvaData.filter(r=>r.section==="Expense").reduce((a,b)=>a+b.budget,0) : 0;
  const totalActual = bvaData ? bvaData.filter(r=>r.section==="Income").reduce((a,b)=>a+b.actual,0) - bvaData.filter(r=>r.section==="Expense").reduce((a,b)=>a+b.actual,0) : 0;

  const card = (style={}) => ({ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, ...style });

  // ── RENDER ────────────────────────────────────────────────────
  return (
    <div style={{ background: C.bg, minHeight: "100vh", padding: "28px 20px", fontFamily: "Inter, system-ui, sans-serif", color: C.text }}>
      <div style={{ maxWidth: 920, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 28 }}>
          {view !== "home" && (
            <button onClick={() => { setView("home"); setActiveProperty(null); setBvaData(null); }}
              style={{ background: "none", border: "none", color: C.sub, cursor: "pointer", fontSize: 20 }}>←</button>
          )}
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>
              📊 BVA Tool {activeProperty && <span style={{ color: C.accent }}>/ {activeProperty.name}</span>}
            </h1>
            {view === "home" && <p style={{ color: C.sub, margin: "4px 0 0", fontSize: 13 }}>ניהול תקציב מול ביצוע לפי נכס</p>}
          </div>
        </div>

        {/* HOME — property list */}
        {view === "home" && (
          <>
            <div style={{ display: "flex", gap: 10, marginBottom: 24 }}>
              <input value={newPropName} onChange={e => setNewPropName(e.target.value)}
                onKeyDown={e => e.key === "Enter" && createProperty()}
                placeholder="שם נכס חדש..."
                style={{ flex: 1, padding: "10px 14px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.card, color: C.text, fontSize: 14 }} />
              <Btn onClick={createProperty} disabled={!newPropName.trim()}>+ צור תיקייה</Btn>
            </div>
            {properties.length === 0 && (
              <div style={{ ...card({ padding: 40 }), textAlign: "center", color: C.muted }}>
                אין נכסים עדיין — צור תיקייה ראשונה
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px,1fr))", gap: 14 }}>
              {properties.map(p => (
                <div key={p.id} onClick={() => openProperty(p)}
                  style={{ ...card({ padding: "20px 18px", cursor: "pointer" }) }}>
                  <div style={{ fontSize: 28, marginBottom: 8 }}>🏢</div>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{p.name}</div>
                  <div style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>לחץ לפתיחה</div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* PROPERTY view */}
        {view === "property" && activeProperty && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

            {/* Upload section */}
            <div style={card({ padding: 20 })}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 16 }}>📤 העלאת קבצים</div>
              <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
                {["budget","actual"].map(t => (
                  <button key={t} onClick={() => setUploadType(t)} style={{
                    padding: "7px 18px", borderRadius: 8, border: "none", cursor: "pointer", fontWeight: 600, fontSize: 13,
                    background: uploadType === t ? C.accent : C.border, color: "#fff",
                  }}>{t === "budget" ? "📋 תקציב" : "📄 P&L בפועל"}</button>
                ))}
              </div>
              <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
                <DropZone label={uploadType === "budget" ? "קובץ תקציב" : "קובץ P&L"} file={uploadFile} onFile={setUploadFile} />
                <Btn onClick={handleUpload} disabled={!uploadFile || uploading}>
                  {uploading ? uploadMsg : "העלה"}
                </Btn>
              </div>
              {uploadResult && (
                <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 8,
                  background: uploadResult.ok ? "#0d2a1a" : "#2a0d0d",
                  color: uploadResult.ok ? C.green : C.red, fontSize: 13 }}>
                  {uploadResult.ok
                    ? `✅ נשמרו ${uploadResult.months} חודש/ים בהצלחה${uploadResult.property ? ` (${uploadResult.property})` : ""}`
                    : `❌ שגיאה: ${uploadResult.msg}`}
                </div>
              )}
            </div>

            {/* Months status */}
            <div style={{ display: "flex", gap: 14 }}>
              {[["📋 תקציב", budgetMonths], ["📄 P&L בפועל", actualMonths]].map(([label, months]) => (
                <div key={label} style={{ ...card({ padding: 16 }), flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: C.sub, marginBottom: 10 }}>{label}</div>
                  {months.length === 0
                    ? <div style={{ color: C.muted, fontSize: 12 }}>אין נתונים</div>
                    : <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {months.map(m => (
                          <span key={`${m.year}-${m.month}`} style={{
                            background: "#1e2035", border: `1px solid ${C.border}`,
                            borderRadius: 6, padding: "3px 10px", fontSize: 12, color: C.sub,
                          }}>{MONTHS[m.month - 1]} {m.year}</span>
                        ))}
                      </div>
                  }
                </div>
              ))}
            </div>

            {/* Analyze section */}
            <div style={card({ padding: 20 })}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 16 }}>🔍 ניתוח BVA</div>
              {commonMonths.length === 0
                ? <div style={{ color: C.muted, fontSize: 13 }}>אין חודשים משותפים לתקציב ו-P&L עדיין</div>
                : <>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
                      {commonMonths.map(m => {
                        const key = `${m.year}-${m.month}`;
                        const selected = selMonths.some(s => s.year === m.year && s.month === m.month);
                        return (
                          <button key={key}
                            onClick={() => {
                              setSelMonths(prev => selected
                                ? prev.filter(s => !(s.year === m.year && s.month === m.month))
                                : [...prev, { year: m.year, month: m.month }]);
                              setBvaData(null); setInsights(null);
                            }}
                            style={{
                              padding: "7px 14px", borderRadius: 8, border: "none", cursor: "pointer", fontWeight: 600, fontSize: 13,
                              background: selected ? C.accent : C.border, color: "#fff",
                            }}>{MONTHS[m.month-1]} {m.year}</button>
                        );
                      })}
                    </div>
                    <Btn onClick={runAnalysis} disabled={selMonths.length === 0 || analyzing}>
                      {analyzing ? "מנתח..." : "הפק ניתוח"}
                    </Btn>
                  </>
              }
            </div>

            {/* BVA Results */}
            {bvaData && (() => {
              const selectedMonths = [...new Map(bvaData.map(r => [`${r.year}-${r.month}`, { year: r.year, month: r.month }])).values()]
                .sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month);
              return (
                <>
                  {/* NOI summary — one card per month */}
                  <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                    {selectedMonths.map(({ year, month }) => {
                      const mRows = bvaData.filter(r => r.year === year && r.month === month);
                      const budgetNOI = mRows.filter(r => r.section === "Income").reduce((a, b) => a + b.budget, 0)
                                      - mRows.filter(r => r.section === "Expense").reduce((a, b) => a + b.budget, 0);
                      const actualNOI = mRows.filter(r => r.section === "Income").reduce((a, b) => a + b.actual, 0)
                                       - mRows.filter(r => r.section === "Expense").reduce((a, b) => a + b.actual, 0);
                      const delta = actualNOI - budgetNOI;
                      return (
                        <div key={`${year}-${month}`} style={{ ...card({ padding: "14px 18px" }), flex: 1, minWidth: 200 }}>
                          <div style={{ color: C.accent, fontWeight: 700, fontSize: 12, marginBottom: 10 }}>{MONTHS[month - 1]} {year}</div>
                          <div style={{ display: "flex", gap: 16 }}>
                            <div>
                              <div style={{ color: C.muted, fontSize: 10, marginBottom: 2 }}>תקציב</div>
                              <div style={{ fontWeight: 700, fontSize: 15, color: C.text }}>${budgetNOI.toLocaleString("en-US", { maximumFractionDigits: 0 })}</div>
                            </div>
                            <div>
                              <div style={{ color: C.muted, fontSize: 10, marginBottom: 2 }}>בפועל</div>
                              <div style={{ fontWeight: 700, fontSize: 15, color: C.text }}>${actualNOI.toLocaleString("en-US", { maximumFractionDigits: 0 })}</div>
                            </div>
                            <div>
                              <div style={{ color: C.muted, fontSize: 10, marginBottom: 2 }}>סטייה</div>
                              <div style={{ fontWeight: 700, fontSize: 15, color: delta >= 0 ? C.green : C.red }}>
                                {delta >= 0 ? "+" : ""}{delta.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {sections.map(sec => {
                    const secRows = bvaData.filter(r => r.section === sec);
                    const cats = [...new Set(secRows.map(r => r.category))];
                    const isGoodDelta = delta => sec === "Expense" ? delta <= 0 : delta >= 0;
                    return (
                      <div key={sec} style={card({ overflow: "hidden" })}>
                        <div style={{ padding: "11px 16px", borderBottom: `1px solid ${C.border}`, fontWeight: 700, fontSize: 12, color: C.sub, textTransform: "uppercase", letterSpacing: 1 }}>
                          {sec === "Income" ? "📈 הכנסות" : sec === "Expense" ? "📉 הוצאות" : sec === "NOI" ? "💰 NOI" : sec}
                        </div>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                          <thead>
                            <tr style={{ background: "#13151f" }}>
                              <th style={{ padding: "9px 14px", textAlign: "left", color: C.muted, fontWeight: 600, fontSize: 11 }}>קטגוריה</th>
                              {selectedMonths.flatMap(({ year, month }) => [
                                <th key={`b-${year}-${month}`} style={{ padding: "9px 14px", textAlign: "right", color: C.muted, fontWeight: 600, fontSize: 11 }}>תקציב {MONTHS[month - 1]}</th>,
                                <th key={`a-${year}-${month}`} style={{ padding: "9px 14px", textAlign: "right", color: C.muted, fontWeight: 600, fontSize: 11 }}>בפועל {MONTHS[month - 1]}</th>,
                                <th key={`d-${year}-${month}`} style={{ padding: "9px 14px", textAlign: "right", color: C.muted, fontWeight: 600, fontSize: 11 }}>Δ {MONTHS[month - 1]}</th>,
                              ])}
                            </tr>
                          </thead>
                          <tbody>
                            {cats.map(cat => (
                              <tr key={cat} style={{ borderTop: `1px solid ${C.border}` }}>
                                <td style={{ padding: "9px 14px", color: C.text }}>{cat}</td>
                                {selectedMonths.flatMap(({ year, month }) => {
                                  const row = secRows.find(r => r.category === cat && r.year === year && r.month === month);
                                  const budget = row?.budget ?? 0;
                                  const actual = row?.actual ?? 0;
                                  const delta = actual - budget;
                                  const deltaBg = Math.abs(delta) < 0.5 ? "transparent" : isGoodDelta(delta) ? "#0d2a1a" : "#2a0d0d";
                                  return [
                                    <td key={`b-${year}-${month}`} style={{ padding: "9px 14px", textAlign: "right", color: C.sub }}>${budget.toLocaleString("en-US", { maximumFractionDigits: 0 })}</td>,
                                    <td key={`a-${year}-${month}`} style={{ padding: "9px 14px", textAlign: "right", color: C.text }}>${actual.toLocaleString("en-US", { maximumFractionDigits: 0 })}</td>,
                                    <td key={`d-${year}-${month}`} style={{ padding: "9px 14px", textAlign: "right", background: deltaBg, color: C.text }}>{delta >= 0 ? "+" : ""}{delta.toLocaleString("en-US", { maximumFractionDigits: 0 })}</td>,
                                  ];
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    );
                  })}

                  {/* AI Insights */}
                <div style={card({ padding: 20 })}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom: insights?14:0 }}>
                    <div style={{ fontWeight:700, fontSize:15 }}>💡 תובנות AI</div>
                    {!insights && <Btn onClick={async()=>{setInsightLoading(true);setInsights(await getInsights(bvaData).catch(()=>"שגיאה").finally(()=>setInsightLoading(false)));}} disabled={insightLoading} small>
                      {insightLoading?"מנתח...":"הפק תובנות"}
                    </Btn>}
                  </div>
                  {insights && <div style={{ color:C.sub, fontSize:14, lineHeight:1.8, whiteSpace:"pre-wrap" }}>{insights}</div>}
                </div>
              </>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
