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
  await sbFetch(`/${table}`, {
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

// ── File parsing & AI helpers ─────────────────────────────────────
async function readFileRows(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const wb = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      resolve(XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" }));
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

async function parseFileWithClaude(file, fileType) {
  const rows = await readFileRows(file);

  // Send only the first 20 rows + all unique category names to AI
  // AI returns structure map (tiny response) — data extraction done locally
  const sampleRows = rows.slice(0, 20);
  const allCats = [...new Set(
    rows.slice(1).map(r => String(r[0] || "").trim()).filter(v => v && !/^[\d$,()\-+.]+$/.test(v))
  )].slice(0, 100);

  const sampleText = sampleRows.map(r => r.slice(0, 20).join("\t")).join("\n");

  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      system: `You analyze real estate ${fileType} spreadsheet structure.
Return ONLY raw JSON (no markdown):
{
  "headerRow": <0-based row index containing month headers, or -1 if none>,
  "categoryCol": <0-based column index for category names>,
  "valueCol": <0-based column index for values if single-period, else -1>,
  "year": <inferred year as integer>,
  "months": [{"col": <col index>, "month": <1-12>}],
  "categories": {"<name>": "Income|Expense|NOI|Other"}
}`,
      messages: [{ role: "user", content: `First rows (tab-separated):\n${sampleText}\n\nAll categories:\n${allCats.join("\n")}` }],
    }),
  });

  const aiData = await res.json();
  const aiText = aiData.content?.map(b => b.text || "").join("") || "";
  const jsonStart = aiText.indexOf("{");
  if (jsonStart === -1) throw new Error("AI לא זיהה מבנה: " + aiText.slice(0, 200));
  const structure = JSON.parse(aiText.slice(jsonStart));

  const { categoryCol = 0, valueCol = -1, year = new Date().getFullYear(),
    months = [], categories = {}, headerRow = 0 } = structure;
  const dataStart = headerRow >= 0 ? headerRow + 1 : 1;

  // Helper: parse a cell value to float
  const toNum = v => parseFloat(String(v || "").replace(/[$,()]/g, "")) || 0;

  if (months.length === 0) {
    // Single-period file
    const valCol = valueCol >= 0 ? valueCol : (() => {
      const counts = {};
      for (let ri = dataStart; ri < Math.min(rows.length, dataStart + 20); ri++) {
        for (let ci = 1; ci < (rows[ri]?.length || 0); ci++) {
          if (ci === categoryCol) continue;
          const n = parseFloat(String(rows[ri][ci]).replace(/[$,]/g, ""));
          if (!isNaN(n) && n !== 0) counts[ci] = (counts[ci] || 0) + 1;
        }
      }
      return parseInt(Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "1");
    })();

    const currentMonth = new Date().getMonth() + 1;
    const items = [];
    for (let ri = dataStart; ri < rows.length; ri++) {
      const cat = String(rows[ri]?.[categoryCol] ?? "").trim();
      if (!cat) continue;
      const val = toNum(rows[ri]?.[valCol]);
      items.push({ category: cat, section: categories[cat] || "Other", value: val });
    }
    return { property: null, months: [{ year, month: currentMonth, items }] };
  }

  // Multi-month file
  const monthMap = {};
  for (const m of months) {
    monthMap[m.month] = { year, month: m.month, items: [] };
  }
  for (let ri = dataStart; ri < rows.length; ri++) {
    const cat = String(rows[ri]?.[categoryCol] ?? "").trim();
    if (!cat) continue;
    for (const m of months) {
      const val = toNum(rows[ri]?.[m.col]);
      monthMap[m.month]?.items.push({ category: cat, section: categories[cat] || "Other", value: val });
    }
  }
  return { property: null, months: Object.values(monthMap).filter(m => m.items.some(i => i.value !== 0)) };
}

async function getInsights(matches) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: `אתה אנליסט נדל"ן. נתח את ה-BVA הבא ותן 3-5 תובנות קצרות בעברית. היה ספציפי עם מספרים.\n\n${JSON.stringify(matches)}`,
      }],
    }),
  });
  const data = await res.json();
  return data.content?.map(b => b.text || "").join("") || "";
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

function VarianceRow({ row }) {
  const isIncome = row.section === "Income";
  const diff = row.actual - row.budget;
  const isGood = isIncome ? diff >= 0 : diff <= 0;
  const pct = row.budget !== 0 ? (diff / Math.abs(row.budget)) * 100 : 0;
  const color = Math.abs(diff) < 0.5 ? C.muted : isGood ? C.green : C.red;
  const fmt = v => "$" + Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
  return (
    <tr style={{ borderTop: `1px solid ${C.border}` }}>
      <td style={{ padding: "9px 14px", color: C.text }}>{row.category}</td>
      <td style={{ padding: "9px 14px", textAlign: "right", color: C.sub }}>{fmt(row.budget)}</td>
      <td style={{ padding: "9px 14px", textAlign: "right", color: C.text }}>{fmt(row.actual)}</td>
      <td style={{ padding: "9px 14px", textAlign: "right" }}>
        <span style={{ color, fontWeight: 600 }}>
          {diff >= 0 ? "+" : ""}{diff.toLocaleString("en-US", { maximumFractionDigits: 0 })}
        </span>
        <span style={{ color: C.muted, fontSize: 11, marginLeft: 5 }}>
          ({pct >= 0 ? "+" : ""}{pct.toFixed(1)}%)
        </span>
      </td>
    </tr>
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
  const [selYear, setSelYear] = useState(null);
  const [selMonth, setSelMonth] = useState(null);
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
      setUploadMsg("AI מנתח...");
      const parsed = await parseFileWithClaude(uploadFile, uploadType === "budget" ? "budget" : "P&L actual");
      setUploadMsg(`שומר ${parsed.months.length} חודש/ים...`);
      const table = uploadType === "budget" ? "bva_budget" : "bva_actual";
      let saved = 0;
      for (const m of parsed.months) {
        const rows = m.items.map(item => ({
          property_id: activeProperty.id,
          year: m.year, month: m.month,
          category: item.category, section: item.section, value: item.value,
          updated_at: new Date().toISOString(),
        }));
        await upsertRows(table, rows);
        saved++;
      }
      setUploadResult({ ok: true, months: parsed.months.length, property: parsed.property });
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
    if (!selYear || !selMonth || !activeProperty) return;
    setAnalyzing(true); setBvaData(null); setInsights(null);
    try {
      const [budgetRows, actualRows] = await Promise.all([
        loadData("bva_budget", activeProperty.id, selYear, selMonth),
        loadData("bva_actual", activeProperty.id, selYear, selMonth),
      ]);
      const budgetMap = Object.fromEntries(budgetRows.map(r => [r.category, r]));
      const actualMap = Object.fromEntries(actualRows.map(r => [r.category, r]));
      const allCats = [...new Set([...Object.keys(budgetMap), ...Object.keys(actualMap)])];
      const matches = allCats.map(cat => ({
        category: cat,
        section: budgetMap[cat]?.section || actualMap[cat]?.section || "Other",
        budget: budgetMap[cat]?.value ?? 0,
        actual: actualMap[cat]?.value ?? 0,
      }));
      setBvaData(matches);
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
                      {commonMonths.map(m => (
                        <button key={`${m.year}-${m.month}`}
                          onClick={() => { setSelYear(m.year); setSelMonth(m.month); setBvaData(null); setInsights(null); }}
                          style={{
                            padding: "7px 14px", borderRadius: 8, border: "none", cursor: "pointer", fontWeight: 600, fontSize: 13,
                            background: selYear===m.year && selMonth===m.month ? C.accent : C.border, color: "#fff",
                          }}>{MONTHS[m.month-1]} {m.year}</button>
                      ))}
                    </div>
                    <Btn onClick={runAnalysis} disabled={!selYear || !selMonth || analyzing}>
                      {analyzing ? "מנתח..." : "הפק ניתוח"}
                    </Btn>
                  </>
              }
            </div>

            {/* BVA Results */}
            {bvaData && (
              <>
                {/* NOI summary */}
                <div style={{ display: "flex", gap: 14 }}>
                  {[["NOI תקציב", totalBudget, false], ["NOI בפועל", totalActual, false], ["סטייה", totalActual-totalBudget, true]].map(([label, val, isVar]) => (
                    <div key={label} style={{ ...card({ padding: "14px 18px" }), flex: 1 }}>
                      <div style={{ color: C.muted, fontSize: 11, marginBottom: 4 }}>{label}</div>
                      <div style={{ fontSize: 20, fontWeight: 700, color: isVar ? (val>=0?C.green:C.red) : C.text }}>
                        {val<0?"-":""}${Math.abs(val).toLocaleString("en-US",{maximumFractionDigits:0})}
                      </div>
                      {isVar && totalBudget!==0 && <div style={{fontSize:11,color:C.muted,marginTop:2}}>{((val/Math.abs(totalBudget))*100).toFixed(1)}%</div>}
                    </div>
                  ))}
                </div>

                {sections.map(sec => (
                  <div key={sec} style={card({ overflow: "hidden" })}>
                    <div style={{ padding: "11px 16px", borderBottom: `1px solid ${C.border}`, fontWeight: 700, fontSize: 12, color: C.sub, textTransform: "uppercase", letterSpacing: 1 }}>
                      {sec==="Income"?"📈 הכנסות":sec==="Expense"?"📉 הוצאות":sec==="NOI"?"💰 NOI":sec}
                    </div>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                      <thead>
                        <tr style={{ background: "#13151f" }}>
                          {["קטגוריה","תקציב","בפועל","סטייה $ / %"].map(h => (
                            <th key={h} style={{ padding:"9px 14px", textAlign: h==="קטגוריה"?"left":"right", color:C.muted, fontWeight:600, fontSize:11 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {bvaData.filter(r=>r.section===sec).map((row,i)=><VarianceRow key={i} row={row}/>)}
                      </tbody>
                    </table>
                  </div>
                ))}

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
            )}
          </div>
        )}
      </div>
    </div>
  );
}
