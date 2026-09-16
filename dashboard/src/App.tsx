import { useEffect, useMemo, useState } from 'react';
import { dashboardSchema, type DashboardSnapshot } from '../shared/protocol.js';

type View = 'Overview' | 'Connections' | 'Sessions' | 'Activity';
const views: View[] = ['Overview', 'Connections', 'Sessions', 'Activity'];

function readToken(): string {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  if (token) {
    window.history.replaceState(null, '', window.location.pathname);
    try { sessionStorage.setItem('synapse-dashboard-token', token); } catch { /* Memory-only fallback. */ }
    return token;
  }
  try { return sessionStorage.getItem('synapse-dashboard-token') ?? ''; } catch { return ''; }
}

function duration(date: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(date)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
function clock(date: string): string { return new Date(date).toLocaleTimeString(); }

function Mark({ small = false }: { small?: boolean }) {
  return <span className={`mark ${small ? 'small' : ''}`} aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 17 12 6l7 11M8 13h8" /></svg></span>;
}

export function App() {
  const [token, setToken] = useState(readToken);
  const [view, setView] = useState<View>('Overview');
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>();
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState('all');

  useEffect(() => {
    const acceptLaunchLink = () => {
      if (new URLSearchParams(window.location.hash.slice(1)).has('token')) setToken(readToken());
    };
    window.addEventListener('hashchange', acceptLaunchLink);
    return () => window.removeEventListener('hashchange', acceptLaunchLink);
  }, []);

  useEffect(() => {
    if (!token) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    async function poll() {
      try {
        const response = await fetch('/api/sessions', {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(7000)]),
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(response.status === 401
          ? 'This link is no longer authorized. Open the private link printed by the running dashboard.'
          : 'The local dashboard is unavailable. Check its terminal and runtime directory.');
        const data = dashboardSchema.parse(await response.json());
        if (stopped) return;
        setSnapshot(data);
        setError('');
        setSelected((id) => id && !data.sessions.some((session) => session.id === id) ? '' : id);
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error && cause.message.startsWith('This link') ? cause.message
          : 'Connection lost. Showing the last snapshot, if available. Check that the dashboard server is running.');
      } finally {
        if (!stopped) timer = setTimeout(() => { void poll(); }, 2000);
      }
    }
    void poll();
    return () => { stopped = true; abort.abort(); clearTimeout(timer); };
  }, [token]);

  const sessions = useMemo(() => snapshot?.sessions.filter((session) => !selected || session.id === selected) ?? [], [snapshot, selected]);
  const services = sessions.flatMap((session) => session.services.map((service) => ({ ...service, sessionId: session.id })));
  const ready = services.filter((service) => service.status === 'ready').length;
  const active = services.reduce((sum, service) => sum + service.activeRequests, 0);
  const completed = sessions.reduce((sum, session) => sum + session.completedCalls, 0);
  const failed = sessions.reduce((sum, session) => sum + session.failedCalls, 0);
  const requests = sessions.flatMap((session) => session.requests.map((request) => ({ ...request, sessionId: session.id })));
  const events = sessions.flatMap((session) => session.events.map((event) => ({ ...event, sessionId: session.id })))
    .sort((a, b) => b.time.localeCompare(a.time))
    .filter((event) => level === 'all' || event.level === level).slice(0, 200);

  function exportEvents() {
    const data = events.map((event) => JSON.stringify(event)).join('\n');
    const url = URL.createObjectURL(new Blob([data ? `${data}\n` : ''], { type: 'application/x-ndjson' }));
    const link = document.createElement('a');
    link.href = url; link.download = `synapse-events-${Date.now()}.jsonl`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="Synapse dashboard home"><Mark /><span>synapse<span className="brand-subtitle">MCP GATEWAY</span></span></a>
      <div className="nav-label">WORKSPACE</div>
      <nav aria-label="Dashboard views">{views.map((item, index) => <button key={item} className={view === item ? 'nav-item active' : 'nav-item'} aria-current={view === item ? 'page' : undefined} onClick={() => setView(item)}><span className="nav-icon" aria-hidden="true">{['◈', '⇄', '▣', '≋'][index]}</span>{item}{item === 'Sessions' && <span className="nav-count">{snapshot?.sessions.length ?? 0}</span>}</button>)}</nav>
      <div className="sidebar-bottom"><span className="local-dot" /> Local workspace<p>Read-only · loopback only<br />No data sent to the cloud</p></div>
    </aside>

    <main>
      <header className="topbar"><span>Workspace <span className="slash">/</span> <strong>{view}</strong></span><span className={`live-state ${error ? 'stale' : ''}`}><i />{error ? 'Snapshot stale' : snapshot ? 'Updating every 2s' : 'Waiting for data'}</span></header>
      <div className="page">
        <div className="page-heading"><div><span className="eyebrow">YOUR GATEWAY, AT A GLANCE</span><h1>{view === 'Overview' ? 'Everything connected.' : view}</h1><p>{view === 'Overview' ? 'A live view of your local MCP services. Nothing more than you need.' : 'Inspect your running gateways without changing their behavior.'}</p></div><span className="pill">READ-ONLY</span></div>

        {!token ? <section className="empty-state"><Mark /><h2>Open your private dashboard link</h2><p>Run <code>bun run start</code> inside <code>dashboard/</code>, then open the link printed in that terminal. It includes a temporary access token.</p><p>No gateway token or tenant credential is needed here.</p></section> : <>
          {error && <div className="notice error" role="alert">{error}</div>}
          {snapshot && (snapshot.unavailable > 0 || snapshot.truncated) && <div className="notice">{snapshot.unavailable > 0 && `${snapshot.unavailable} unavailable or stale telemetry socket(s) skipped. `}{snapshot.truncated && 'Only the first 32 telemetry sockets were inspected.'}</div>}
          <div className="toolbar"><label>Gateway session <select value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">All sessions</option>{snapshot?.sessions.map((session) => <option key={session.id} value={session.id}>{session.id.slice(0, 8)} · PID {session.pid}</option>)}</select></label><span className="muted">{snapshot ? `Last snapshot ${clock(snapshot.capturedAt)}` : 'Connecting to local bridge…'}</span></div>
          <section className="stats" aria-label="Gateway statistics">
            <article className="stat"><span>Gateway sessions</span><strong>{sessions.length}</strong><small>One process, one tenant context</small></article>
            <article className="stat"><span>Connected MCPs</span><strong>{ready}<em> / {services.length}</em></strong><small><span className="green-dot" /> {services.length - ready} not ready</small></article>
            <article className="stat"><span>Active requests</span><strong>{active}</strong><small>Currently executing downstream</small></article>
            <article className="stat"><span>Completed calls</span><strong>{completed}</strong><small>{failed} failed · since process start</small></article>
          </section>

          {snapshot && sessions.length === 0 ? <section className="empty-state"><Mark /><h2>Your gateways will appear here.</h2><p>The dashboard is optional. Enable telemetry only for the gateway processes you want to inspect:</p><pre>MCP_DASHBOARD_ENABLED=true</pre><p>Build the dashboard, add this variable to your gateway's environment, and restart that gateway. Your MCP services stay unchanged.</p><span className="muted">No mock sessions. No credentials collected.</span></section> : <>
            {(view === 'Overview' || view === 'Connections') && <section className="panel"><div className="panel-heading"><div><h2>MCP connections <span className="count">{services.length}</span></h2><p>Services discovered by your selected gateway sessions.</p></div><input aria-label="Filter services" placeholder="Filter services…" value={query} onChange={(event) => setQuery(event.target.value)} /></div><div className="table-wrap"><table><thead><tr><th>Service</th><th>Status</th><th>Transport</th><th>Tools</th><th>Active</th><th>Session</th></tr></thead><tbody>{services.filter((service) => service.name.toLowerCase().includes(query.toLowerCase())).map((service) => <tr key={`${service.sessionId}/${service.name}`}><td><span className="service-icon" aria-hidden="true">↗</span><strong>{service.name}</strong></td><td><span className={`status ${service.status}`}><i />{service.status === 'ready' ? 'Connected' : service.status === 'connecting' ? 'Connecting' : 'Offline'}</span></td><td><code>{service.transport === 'sse' ? 'SSE' : 'Streamable HTTP'}</code></td><td>{service.toolCount}</td><td>{service.activeRequests}</td><td><code>{service.sessionId.slice(0, 8)}</code></td></tr>)}</tbody></table>{services.filter((service) => service.name.toLowerCase().includes(query.toLowerCase())).length === 0 && <p className="empty-row">No matching services.</p>}</div></section>}

            {(view === 'Overview' || view === 'Sessions') && <section className="panel"><div className="panel-heading"><div><h2>Gateway sessions</h2><p>A session is a running gateway—not a conversation or a stored backend session.</p></div></div><div className="session-grid">{sessions.map((session) => <article className="session-card" key={session.id}><div><span className="session-icon" aria-hidden="true">▣</span><span className="status ready"><i />Running</span></div><h3 title={session.id}>{session.id.slice(0, 8)}</h3><p>PID {session.pid} <span className="slash">·</span> Up {duration(session.startedAt)}</p><div className="session-meta"><span>{session.services.length} services</span><span>{session.services.reduce((sum, service) => sum + service.toolCount, 0)} tools</span></div></article>)}</div></section>}

            {(view === 'Overview' || view === 'Activity') && <>
              <section className="panel"><div className="panel-heading"><div><h2>In-flight requests <span className="count">{active}</span></h2><p>Request metadata only. Arguments and results stay private.</p></div></div>{requests.length === 0 ? <p className="empty-row">No active calls right now.</p> : <div className="table-wrap"><table><thead><tr><th>Request</th><th>Service</th><th>Elapsed</th><th>Session</th></tr></thead><tbody>{requests.map((request) => <tr key={request.id}><td><code>{request.id.slice(0, 8)}</code></td><td>{request.service}</td><td>{duration(request.startedAt)}</td><td><code>{request.sessionId.slice(0, 8)}</code></td></tr>)}</tbody></table></div>}{sessions.some((session) => session.requestsTruncated > 0) && <p className="empty-row">Request details are limited to 128 per gateway. Counters include all active requests.</p>}</section>
              <section className="panel"><div className="panel-heading"><div><h2>Recent activity</h2><p>Latest 200 matching events. In-memory history resets when gateways restart.</p></div><div className="actions"><select aria-label="Filter log level" value={level} onChange={(event) => setLevel(event.target.value)}><option value="all">All levels</option><option value="info">Info</option><option value="warn">Warnings</option><option value="error">Errors</option></select><button className="button" disabled={events.length === 0} onClick={exportEvents}>↓ Export JSONL</button></div></div><div className="event-list">{events.length === 0 ? <p className="empty-row">No recent events at this level.</p> : events.map((event, index) => <div className="event" key={`${event.sessionId}-${event.time}-${index}`}><time dateTime={event.time}>{clock(event.time)}</time><span className={`event-level ${event.level}`}>{event.level}</span><span>{event.message}<small>{event.service ?? 'gateway'} · {event.sessionId.slice(0, 8)}</small></span></div>)}</div></section>
            </>}
          </>}
        </>}
        <footer>Synapse MCP <span>Local visibility. No remote administration.</span></footer>
      </div>
    </main>
  </div>;
}
