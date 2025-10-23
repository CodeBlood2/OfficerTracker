import React, { useMemo, useState, useEffect } from "react";
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isWeekend, parseISO, isSameMonth, isBefore, addDays, isAfter } from "date-fns";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

/**
 * Office Attendance Tracker (Standalone, No-Upload, Multi-User Profiles)
 *
 * Changes in this version
 * - ❌ Removed Excel upload + XLSX dependency entirely
 * - ✅ Added Multi-user profiles stored in localStorage (create/rename/delete/switch)
 * - ✅ Per-user month data (holidays & attendance) saved automatically
 * - ✅ Import/Export JSON (fileless), plus "Share link" that embeds the current profile state
 * - ✅ No external UI libraries or CDNs
 * - ✅ Removed on-screen self-test panel (clean UI)
 */

// ---- Storage helpers ----
const LS_KEY = "officeTrackerProfiles_v2";
function loadProfiles() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch { return {}; }
}
function saveProfiles(p) {
  localStorage.setItem(LS_KEY, JSON.stringify(p));
}
function uuid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function monthKey(d) { return format(d, "yyyy-MM"); }

export default function App() {
  // --- Profiles ---
  const [profiles, setProfiles] = useState(() => loadProfiles());
  const ids = Object.keys(profiles);
  const ensureDefault = () => {
    if (ids.length === 0) {
      const id = uuid();
      const now = new Date();
      const base = {
        id, name: "Me",
        joinDate: format(now, "yyyy-MM-dd"),
        daysPerWeek: 3,
        months: {} // "yyyy-MM": { holidays: [iso...], attendance: [iso...] }
      };
      const next = { [id]: base };
      setProfiles(next);
      saveProfiles(next);
      return id;
    }
    return ids[0];
  };
  const [activeId, setActiveId] = useState(() => ensureDefault());

  // URL-import (optional shared link)
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const s = url.searchParams.get("state");
      if (s) {
        const parsed = JSON.parse(atob(decodeURIComponent(s)));
        if (parsed && parsed.id) {
          const next = { ...profiles, [parsed.id]: parsed };
          setProfiles(next);
          setActiveId(parsed.id);
          saveProfiles(next);
          // clean param after import
          url.searchParams.delete("state");
          history.replaceState(null, "", url.toString());
        }
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { saveProfiles(profiles); }, [profiles]);

  const profile = profiles[activeId] || profiles[ensureDefault()];

  // --- Month / Year state (shared UI state; data saved under profile.months[yyyy-MM])
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth()); // 0-11
  const [year, setYear] = useState(now.getFullYear());
  const [joinDate, setJoinDate] = useState(profile.joinDate);
  const [daysPerWeek, setDaysPerWeek] = useState(profile.daysPerWeek);

  // Sync profile fields when active profile changes
  useEffect(() => {
    if (!profile) return;
    setJoinDate(profile.joinDate);
    setDaysPerWeek(profile.daysPerWeek);
  }, [activeId]);

  const currentMonthKey = monthKey(new Date(year, month, 1));
  const monthData = profile.months?.[currentMonthKey] || { holidays: [], attendance: [] };

  const [holidayInput, setHolidayInput] = useState(monthData.holidays.join("\n"));
  const [attendanceDates, setAttendanceDates] = useState(new Set(monthData.attendance));

  // Persist month data whenever it changes
  useEffect(() => {
    const next = { ...profiles };
    const p = { ...profile, joinDate, daysPerWeek, months: { ...profile.months } };
    const holidays = parseHolidayInput(holidayInput, new Date(year, month, 1));
    p.months[currentMonthKey] = {
      holidays: Array.from(holidays).sort(),
      attendance: Array.from(attendanceDates).sort(),
    };
    next[activeId] = p;
    setProfiles(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holidayInput, attendanceDates, joinDate, daysPerWeek, year, month]);

  // Helpers
  const monthStart = useMemo(() => startOfMonth(new Date(year, month, 1)), [year, month]);
  const monthEnd = useMemo(() => endOfMonth(new Date(year, month, 1)), [year, month]);
  const join = useMemo(() => {
    try { return parseISO(joinDate); } catch { return monthStart; }
  }, [joinDate, monthStart]);

  const activeStart = useMemo(() => (isAfter(join, monthStart) ? join : monthStart), [join, monthStart]);
  const activeRange = useMemo(() => ({ start: activeStart, end: monthEnd }), [activeStart, monthEnd]);

  // Build day list
  const days = useMemo(() => eachDayOfInterval(activeRange), [activeRange]);

  const holidays = useMemo(() => parseHolidayInput(holidayInput, monthStart), [holidayInput, monthStart]);

  // Derived counts
  const workingDays = useMemo(() => days.filter(d => !isWeekend(d) && !holidays.has(fmt(d))), [days, holidays]);
  const staticWorkingDays = workingDays.length; // excluding weekends & holidays, respect join date

  // Required office days using ratio policy (e.g., 3/5 of working days)
  const requiredOfficeDays = useMemo(() => {
    const ratio = Number(daysPerWeek) / 5; // assume 5 working days baseline
    return Math.ceil(ratio * staticWorkingDays);
  }, [daysPerWeek, staticWorkingDays]);

  // Completed (from attendance set; only count days within range & not weekends/holidays)
  const completed = useMemo(() => {
    let c = 0;
    for (const s of attendanceDates) {
      const d = parseISO(s);
      if (!isSameMonth(d, monthStart)) continue;
      if (isBefore(d, activeStart) || isAfter(d, monthEnd)) continue;
      if (isWeekend(d)) continue;
      if (holidays.has(fmt(d))) continue;
      c++;
    }
    return c;
  }, [attendanceDates, monthStart, activeStart, monthEnd, holidays]);

  const remaining = Math.max(0, requiredOfficeDays - completed);
  const pct = requiredOfficeDays === 0 ? 100 : Math.min(100, Math.round((completed / requiredOfficeDays) * 100));

  // Chart data (cumulative planned target vs actual)
  const chartData = useMemo(() => {
    let cumulativeActual = 0;
    const points = [];
    const targetPerWorkingDay = requiredOfficeDays / Math.max(1, staticWorkingDays);
    let cumulativeTarget = 0;
    for (const d of eachDayOfInterval({ start: monthStart, end: monthEnd })) {
      const key = fmt(d);
      const isWork = !isWeekend(d) && !holidays.has(key) && !isBefore(d, activeStart);
      if (isWork) {
        cumulativeTarget += targetPerWorkingDay;
        if (attendanceDates.has(key)) cumulativeActual += 1;
      }
      points.push({ date: format(d, "dd MMM"), target: Number(cumulativeTarget.toFixed(2)), actual: cumulativeActual });
    }
    return points;
  }, [attendanceDates, activeStart, holidays, monthStart, monthEnd, requiredOfficeDays, staticWorkingDays]);

  // Toggle a day as attended
  const toggleAttendance = (d) => {
    const key = fmt(d);
    const next = new Set(attendanceDates);
    if (next.has(key)) next.delete(key); else next.add(key);
    setAttendanceDates(next);
  };

  // Profile actions
  const createProfile = () => {
    const id = uuid();
    const base = { id, name: `User ${Object.keys(profiles).length + 1}`, joinDate, daysPerWeek: 3, months: {} };
    const next = { ...profiles, [id]: base };
    setProfiles(next); saveProfiles(next); setActiveId(id);
  };
  const renameProfile = () => {
    const name = prompt("Enter name", profile?.name || "");
    if (!name || !profile) return;
    const next = { ...profiles, [activeId]: { ...profile, name } };
    setProfiles(next); saveProfiles(next);
  };
  const deleteProfile = () => {
    if (!profile) return;
    if (!confirm(`Delete profile "${profile.name}"?`)) return;
    const next = { ...profiles }; delete next[activeId];
    setProfiles(next); saveProfiles(next);
    const newIds = Object.keys(next);
    setActiveId(newIds[0] || ensureDefault());
  };

  // Share link (embed current profile JSON in URL param)
  const makeShareLink = () => {
    const state = encodeURIComponent(btoa(JSON.stringify(profile)));
    const url = new URL(window.location.href);
    url.searchParams.set("state", state);
    return url.toString();
  };

  // Export/Import JSON (fileless)
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(profile, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${(profile.name || "profile").replace(/\s+/g, "_")}.json`;
    document.body.appendChild(a); a.click(); a.remove();
  };
  const importJson = async () => {
    const s = prompt("Paste profile JSON here");
    if (!s) return;
    try {
      const obj = JSON.parse(s);
      if (!obj.id) obj.id = uuid();
      const next = { ...profiles, [obj.id]: obj };
      setProfiles(next); saveProfiles(next); setActiveId(obj.id);
    } catch (e) {
      alert("Invalid JSON");
    }
  };

  const clearMonth = () => {
    setHolidayInput("");
    setAttendanceDates(new Set());
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 p-6">
      <div className="max-w-6xl mx-auto grid gap-6">
        <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">Office Attendance Tracker</h1>
          <div className="flex flex-wrap gap-2 items-center">
            <ProfileSwitcher
              profiles={profiles}
              activeId={activeId}
              onChange={setActiveId}
              onCreate={createProfile}
              onRename={renameProfile}
              onDelete={deleteProfile}
            />
            <button className="px-3 py-2 rounded-md border hover:bg-white" onClick={exportJson}><InlineIcon name="download" className="w-4 h-4 mr-2"/>Export</button>
            <button className="px-3 py-2 rounded-md border hover:bg-white" onClick={importJson}><InlineIcon name="upload" className="w-4 h-4 mr-2"/>Import</button>
            <button className="px-3 py-2 rounded-md border hover:bg-white" onClick={() => { navigator.clipboard.writeText(makeShareLink()); alert("Share link copied to clipboard"); }}><InlineIcon name="link" className="w-4 h-4 mr-2"/>Share link</button>
          </div>
        </header>

        <Panel>
          <div className="p-4 md:p-6 grid md:grid-cols-2 gap-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="col-span-1">
                <label className="text-sm font-medium">Month</label>
                <select className="w-full border rounded-md p-2 bg-white" value={month} onChange={e => setMonth(Number(e.target.value))}>
                  {[...Array(12).keys()].map(m => (
                    <option key={m} value={m}>{format(new Date(2025, m, 1), "MMMM")}</option>
                  ))}
                </select>
              </div>
              <div className="col-span-1">
                <label className="text-sm font-medium">Year</label>
                <input className="w-full border rounded-md p-2" type="number" value={year} onChange={e => setYear(Number(e.target.value))} />
              </div>
              <div className="col-span-2">
                <label className="text-sm font-medium flex items-center gap-2"><InlineIcon name="calendar" className="w-4 h-4"/>Join Date</label>
                <input className="w-full border rounded-md p-2" type="date" value={joinDate} onChange={e => setJoinDate(e.target.value)} />
              </div>
              <div className="col-span-2">
                <label className="text-sm font-medium">Days per week policy</label>
                <input className="w-full border rounded-md p-2" type="number" min={0} max={5} value={daysPerWeek} onChange={e => setDaysPerWeek(Number(e.target.value))} />
              </div>
            </div>

            <div className="grid gap-3">
              <div>
                <label className="text-sm font-medium">Public Holidays (YYYY-MM-DD; comma/line separated)</label>
                <textarea className="w-full border rounded-md p-2 h-24" placeholder="2025-10-02, 2025-10-20" value={holidayInput} onChange={e => setHolidayInput(e.target.value)} />
              </div>
              <div className="flex items-center gap-3">
                <button className="px-3 py-2 rounded-md border hover:bg-white" onClick={clearMonth}><InlineIcon name="refresh" className="w-4 h-4 mr-2"/>Clear this month</button>
              </div>
              <p className="text-xs text-gray-500">Data is saved per user and per month automatically in your browser (localStorage). Use Export/Import or Share link to move it.</p>
            </div>
          </div>
        </Panel>

        <div className="grid md:grid-cols-3 gap-4">
          <Stat title="Static Working Days" value={staticWorkingDays} sub="Weekdays minus holidays, from join date" />
          <Stat title="Required Office Days" value={requiredOfficeDays} sub={`${daysPerWeek}/5 of working days`} />
          <Stat title="Completed / Remaining" value={`${completed} / ${remaining}`} sub="Auto-counted from attendance" />
        </div>

        <Panel>
          <div className="p-4 md:p-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold">Progress</h2>
              <span className="text-sm tabular-nums">{pct}%</span>
            </div>
            <Progress value={pct} />
            <div className="h-56 mt-6">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ left: 8, right: 8, top: 8, bottom: 8 }}>
                  <XAxis dataKey="date" interval={Math.max(0, Math.floor(chartData.length/6))} tick={{ fontSize: 12 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                  <Tooltip formatter={(v) => Math.round(Number(v))} />
                  <Line type="monotone" dataKey="target" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="actual" strokeWidth={2} dot={false} />
                  <ReferenceLine y={requiredOfficeDays} strokeDasharray="3 3" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </Panel>

        <CalendarGrid
          monthStart={monthStart}
          monthEnd={monthEnd}
          joinDate={activeStart}
          holidays={holidays}
          attendanceDates={attendanceDates}
          onToggle={toggleAttendance}
        />

        <Panel>
          <div className="p-4 md:p-6 text-sm text-gray-600 leading-6">
            <h3 className="font-semibold text-gray-800 mb-2">How totals are calculated</h3>
            <ul className="list-disc ml-5">
              <li><b>Static Working Days</b> = Weekdays (Mon–Fri) in the selected month on/after your join date, minus holidays.</li>
              <li><b>Required Office Days</b> = ceil((DaysPerWeek / 5) × Static Working Days). Example: 3/5 of 19 = 12.</li>
              <li><b>Completed</b> counts days you mark as attended that are valid working days within the month.</li>
            </ul>
            <p className="mt-2">No spreadsheet needed. Everything is saved per user/profile and month.</p>
          </div>
        </Panel>
      </div>
    </div>
  );
}

// --- Presentational primitives (no external UI libs) ---
function Panel({ children }) {
  return (
    <div className="border rounded-2xl bg-white shadow-sm">{children}</div>
  );
}

function Progress({ value }) {
  return (
    <div className="w-full h-3 rounded-full bg-gray-200 overflow-hidden">
      <div
        className="h-full bg-emerald-500"
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

function InlineIcon({ name, className = "" }) {
  const common = { className };
  if (name === "calendar") {
    return (
      <svg {...common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
        <line x1="16" y1="2" x2="16" y2="6"/>
        <line x1="8" y1="2" x2="8" y2="6"/>
        <line x1="3" y1="10" x2="21" y2="10"/>
      </svg>
    );
  }
  if (name === "upload") {
    return (
      <svg {...common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="17 8 12 3 7 8"/>
        <line x1="12" y1="3" x2="12" y2="15"/>
      </svg>
    );
  }
  if (name === "download") {
    return (
      <svg {...common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
    );
  }
  if (name === "link") {
    return (
      <svg {...common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 13a5 5 0 0 1 7 0l3 3a5 5 0 0 1-7 7l-1-1"/>
        <path d="M14 11a5 5 0 0 1-7 0l-3-3a5 5 0 0 1 7-7l1 1"/>
      </svg>
    );
  }
  if (name === "refresh") {
    return (
      <svg {...common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="23 4 23 10 17 10"/>
        <polyline points="1 20 1 14 7 14"/>
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/>
        <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/>
      </svg>
    );
  }
  return null;
}

function Stat({ title, value, sub }) {
  return (
    <div className="border rounded-2xl bg-white shadow-sm p-4">
      <div className="text-sm text-gray-500">{title}</div>
      <div className="text-3xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-gray-500 mt-1">{sub}</div>
    </div>
  );
}

function ProfileSwitcher({ profiles, activeId, onChange, onCreate, onRename, onDelete }) {
  const ids = Object.keys(profiles);
  return (
    <div className="flex items-center gap-2">
      <select className="border rounded-md p-2 bg-white" value={activeId} onChange={(e) => onChange(e.target.value)}>
        {ids.map(id => <option key={id} value={id}>{profiles[id].name || id}</option>)}
      </select>
      <button className="px-3 py-2 rounded-md border hover:bg-white" onClick={onCreate}>New</button>
      <button className="px-3 py-2 rounded-md border hover:bg-white" onClick={onRename}>Rename</button>
      <button className="px-3 py-2 rounded-md border hover:bg-white" onClick={onDelete}>Delete</button>
    </div>
  );
}

function CalendarGrid({ monthStart, monthEnd, joinDate, holidays, attendanceDates, onToggle }) {
  const weeks = buildCalendarWeeks(monthStart, monthEnd);
  const isJoinActive = (d) => !isBefore(d, joinDate);
  const isHoliday = (d) => holidays.has(fmt(d));
  const attended = (d) => attendanceDates.has(fmt(d));

  return (
    <Panel>
      <div className="p-4 md:p-6">
        <h2 className="text-lg font-semibold mb-3">Mark Attendance (click to toggle)</h2>
        <div className="grid grid-cols-7 text-center text-xs font-medium text-gray-500 mb-2">
          {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((d) => <div key={d} className="py-1">{d}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-2">
          {weeks.map((week, wi) => week.map((d, di) => {
            const inMonth = isSameMonth(d, monthStart);
            const disabled = !inMonth || isWeekend(d) || isJoinActive(d) === false;
            const holiday = isHoliday(d);
            const isAtt = attended(d);
            const base = "aspect-square rounded-2xl border flex items-center justify-center select-none";
            const muted = !inMonth ? "opacity-30" : "";
            const weekend = isWeekend(d) ? "bg-gray-50 text-gray-400" : "";
            const hol = holiday ? "bg-rose-50 border-rose-200" : "";
            const att = isAtt ? "bg-emerald-100 border-emerald-300" : "";
            const clickable = (!disabled && !holiday && !isWeekend(d)) ? "cursor-pointer hover:shadow" : "";
            return (
              <div
                key={`${wi}-${di}`}
                onClick={() => { if (!disabled && !holiday && !isWeekend(d)) onToggle(d); }}
                className={[base, muted, weekend, hol, att, clickable].join(" ")}
                title={format(d, "yyyy-MM-dd")}
              >
                <div className="text-sm font-medium">{format(d, "d")}</div>
              </div>
            );
          }))}
        </div>
        <div className="text-xs text-gray-500 mt-3 flex flex-wrap gap-4">
          <Legend swatchClass="bg-emerald-200" label="Attended"/>
          <Legend swatchClass="bg-rose-200" label="Holiday"/>
          <Legend swatchClass="bg-gray-100" label="Weekend"/>
          <Legend swatchClass="" label="Click weekday to toggle"/>
        </div>
      </div>
    </Panel>
  );
}

function Legend({ swatchClass, label }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`w-3 h-3 rounded ${swatchClass} border`}></span>
      {label}
    </span>
  );
}

// --- Utils ---
function fmt(d) { return format(d, "yyyy-MM-dd"); }

function parseHolidayInput(input, monthStart) {
  const items = new Set();
  const parts = input.split(/\n|,|;|\s+/).map(s => s.trim()).filter(Boolean);
  for (const tok of parts) {
    const d = safeParseDate(tok);
    if (d && isSameMonth(d, monthStart)) items.add(fmt(d));
  }
  return items;
}

function safeParseDate(s) {
  if (!s) return null;
  if (s instanceof Date && !isNaN(s)) return s;
  try { return parseISO(String(s)); } catch {}
  return null;
}

function buildCalendarWeeks(monthStart, monthEnd) {
  // Start from Monday grid
  const first = startOfWeekMonday(monthStart);
  const last = endOfWeekSunday(monthEnd);
  const all = eachDayOfInterval({ start: first, end: last });
  const out = [];
  for (let i = 0; i < all.length; i += 7) out.push(all.slice(i, i+7));
  return out;
}
function startOfWeekMonday(d) {
  const day = d.getDay(); // 0 Sun .. 6 Sat
  const diff = (day === 0 ? -6 : 1 - day); // back to Monday
  return addDays(d, diff);
}
function endOfWeekSunday(d) {
  const day = d.getDay();
  const diff = (day === 0 ? 0 : 7 - day);
  return addDays(d, diff);
}
