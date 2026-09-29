import { useEffect, useRef, useState } from 'react';
import type {
  Discovery,
  Journal,
  MatchingMode,
  MigrationPlan,
  SpotifySnapshot,
} from '../shared/types';

type State = {
  csrf: string;
  auth: Record<'spotify' | 'soundcloud', { configured: boolean; connected: boolean }>;
  snapshot: SpotifySnapshot | null;
  discovery: (Discovery & { historicalError?: string | null }) | null;
  matchingMode: MatchingMode;
  aggressive: {
    status: string;
    processed: number;
    summary: {
      verified: number;
      aggressive: number;
      notFound: number;
      hardRejectedAll: number;
      skipped: number;
    };
    error: string | null;
  } | null;
  backup: { complete: boolean } | null;
  plan: MigrationPlan | null;
  journal: Journal | null;
  job: { running: boolean; done: number; total: number; error: string };
  guided: { running: boolean; phase: string; error: string; retryAt: string | null };
};

const steps = ['Подключение', 'Сканирование', 'Совпадения', 'Подготовка', 'Перенос', 'Готово'];
const countReady = (state: State) =>
  Object.values(state.discovery?.mappings || {}).filter((m) => !!m.acceptedUrn).length;
const countSkipped = (state: State) =>
  Object.values(state.discovery?.mappings || {}).filter((m) => !!m.processedAt && !m.acceptedUrn)
    .length;
const verifiedPlaylists = (state: State) =>
  state.plan?.playlists.filter(
    (item) =>
      item.kind !== 'LIKES_STAGING' &&
      item.sourceId !== null &&
      state.journal?.playlists[item.key]?.verified,
  ).length || 0;
const sourcePlaylistTotal = (state: State) =>
  state.plan?.playlists.filter((item) => item.kind !== 'LIKES_STAGING' && item.sourceId !== null)
    .length || 0;
const stagingPartial = (state: State) =>
  state.plan?.playlists
    .filter(
      (item) =>
        item.kind === 'LIKES_STAGING' ||
        (item.sourceId === null && /^Spotify Likes \d{3}$/.test(item.title)),
    )
    .filter((item) => state.journal?.playlists[item.key]?.stagingStatus === 'PARTIAL').length || 0;
const stagingSkipped = (state: State) =>
  state.plan?.playlists
    .filter(
      (item) =>
        item.kind === 'LIKES_STAGING' ||
        (item.sourceId === null && /^Spotify Likes \d{3}$/.test(item.title)),
    )
    .filter((item) => state.journal?.playlists[item.key]?.stagingStatus === 'SKIPPED').length || 0;
const verifiedLikes = (state: State) =>
  Object.values(state.journal?.likes || {}).filter((p) => p.stateAfter === 'PRESENT').length;
const duplicateLoss = (state: State) =>
  state.plan?.playlists.flatMap((p) => {
    const record = state.journal?.playlists[p.key];
    return record?.duplicateFallbackAccepted
      ? [
          {
            title: p.title,
            count:
              record.mismatch?.duplicatePlannedUrns.reduce(
                (n, d) => n + d.positions.length - 1,
                0,
              ) || p.urns.length - new Set(p.urns).size,
          },
        ]
      : [];
  }) || [];
const initialStep = (s: State) =>
  s.journal?.status === 'completed'
    ? 6
    : s.plan
      ? Object.keys(s.journal?.playlists || {}).length ||
        s.guided.running ||
        s.journal?.status !== 'idle'
        ? 5
        : 4
      : s.discovery?.status === 'completed'
        ? s.aggressive?.status === 'completed'
          ? 4
          : 3
        : s.snapshot
          ? 2
          : 1;
function friendly(error: string, state?: State | null) {
  if (
    state?.journal?.status === 'PAUSED_STORAGE_ERROR' ||
    /storage|checkpoint|EPERM|EACCES|EBUSY/i.test(error)
  )
    return 'Не удалось сохранить прогресс на диск. Перенос приостановлен.';
  if (state?.journal?.rateLimit?.upstreamStatus === 429 || /429|rate.?limit/i.test(error))
    return 'SoundCloud временно ограничил новые лайки. Прогресс сохранён — продолжите позже.';
  if (/playlist.*mismatch|read.back|different than expected/i.test(error))
    return 'SoundCloud изменил плейлист при сохранении. Перенос остановлен, чтобы не создать неверную копию.';
  if (/Another (job|operation)|current operation/i.test(error))
    return 'Дождитесь завершения текущего действия.';
  if (/account changed/i.test(error))
    return 'Подключён другой аккаунт SoundCloud. Вернитесь к исходному аккаунту.';
  if (/network|fetch failed/i.test(error))
    return 'Нет связи с сервисом. Проверьте подключение и попробуйте снова.';
  return 'Не удалось завершить действие. Прогресс сохранён; подробности доступны ниже.';
}

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmTransfer, setConfirmTransfer] = useState(false);
  const [showSkipped, setShowSkipped] = useState(false);
  const [diagnostic, setDiagnostic] = useState<unknown>(null);
  const [matchingRequested, setMatchingRequested] = useState(false);
  const [safeChosen, setSafeChosen] = useState(false);
  const stateRef = useRef<State | null>(null);
  const matchTransition = useRef(false);
  const refresh = async () => {
    const response = await fetch('/api/state');
    if (!response.ok) throw new Error('State unavailable');
    const next = (await response.json()) as State;
    stateRef.current = next;
    setState(next);
    if (
      next.guided.running ||
      Object.keys(next.journal?.playlists || {}).length ||
      next.journal?.status === 'completed'
    )
      setStep(initialStep(next));
    return next;
  };
  useEffect(() => {
    void refresh()
      .then((s) => {
        setStep(initialStep(s));
        setMatchingRequested(
          s.discovery?.status === 'running' || s.aggressive?.status === 'running',
        );
      })
      .catch((e) => setError(String(e)));
    const timer = setInterval(() => void refresh().catch(() => {}), 2500);
    return () => clearInterval(timer);
  }, []);
  const post = async (path: string, body: unknown = {}) => {
    const response = await fetch(`/api/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': stateRef.current!.csrf },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Request failed');
    return payload;
  };
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (
      !matchingRequested ||
      !state ||
      state.job.running ||
      busy ||
      matchTransition.current ||
      state.plan
    )
      return;
    if (state.discovery?.status === 'completed' && state.aggressive?.status !== 'completed') {
      matchTransition.current = true;
      void run(() => post('flow/match')).finally(() => {
        matchTransition.current = false;
      });
    } else if (state.aggressive?.status === 'completed') {
      setMatchingRequested(false);
      setStep(4);
    }
  }, [state, matchingRequested, busy]);
  if (!state)
    return (
      <main className="shell">
        <h1>Spotify → SoundCloud</h1>
        <p>Загружаем сохранённый прогресс…</p>
        {error && <p role="alert">{friendly(error)}</p>}
      </main>
    );
  const connected = state.auth.spotify.connected && state.auth.soundcloud.connected;
  const scanned = !!state.snapshot && !!state.backup?.complete;
  const matched =
    state.discovery?.status === 'completed' &&
    (safeChosen || state.aggressive?.status === 'completed');
  const playlistsDone = verifiedPlaylists(state),
    playlistsTotal = sourcePlaylistTotal(state);
  const likesDone = verifiedLikes(state),
    likesTotal = state.plan?.plannedLikes.length || 0;
  const skipped = state.plan?.notFound.length ?? countSkipped(state);
  const duplicateEntries = duplicateLoss(state);
  const transferStarted =
    !!state.guided.running || playlistsDone > 0 || state.journal?.status !== 'idle';
  const paused = !state.guided.running && step === 5 && state.journal?.status !== 'completed';
  const technicalError = error || state.guided.error || state.job.error || '';
  const retryAt = state.journal?.rateLimit?.retryAt || null;
  const retryMinutes =
    retryAt && Date.parse(retryAt) > Date.now()
      ? Math.ceil((Date.parse(retryAt) - Date.now()) / 60000)
      : 0;
  const active = Math.max(step, initialStep(state));
  return (
    <main className="shell">
      <header className="hero">
        <div className="brand">
          <span className="brand-mark">↗</span>
          <span>Spotify → SoundCloud</span>
        </div>
        <p className="eyebrow">ПЕРЕНОС БИБЛИОТЕКИ</p>
        <h1>{active === 6 ? 'Музыка на новом месте.' : 'Вся ваша музыка — шаг за шагом.'}</h1>
        <p className="hero-copy">
          Подключите аккаунты, проверьте результат поиска и запустите перенос. Прогресс сохраняется
          автоматически.
        </p>
      </header>
      <nav className="stepper" aria-label="Этапы переноса">
        {steps.map((label, i) => (
          <div
            key={label}
            className={`step ${active === i + 1 ? 'current' : ''} ${active > i + 1 ? 'complete' : ''}`}
            aria-current={active === i + 1 ? 'step' : undefined}
          >
            <span className="step-index">
              {active > i + 1 ? '✓' : String(i + 1).padStart(2, '0')}
            </span>
            <span>{label}</span>
          </div>
        ))}
      </nav>
      {technicalError && (
        <div className="message error" role="alert">
          <strong>{friendly(technicalError, state)}</strong>
          <details>
            <summary>Технические подробности</summary>
            <pre>{technicalError}</pre>
          </details>
        </div>
      )}
      {state.journal?.status === 'RATE_LIMITED' &&
        state.journal.rateLimit?.upstreamStatus === 429 &&
        !technicalError &&
        !state.guided.running && (
          <div className="message warning">
            SoundCloud временно ограничил новые лайки. Прогресс сохранён — продолжите позже.
            {retryMinutes > 0 && ` Попробуйте снова примерно через ${retryMinutes} мин.`}
          </div>
        )}
      {state.journal?.status === 'PAUSED_STORAGE_ERROR' && (
        <div className="message error">
          Не удалось сохранить прогресс на диск. Перенос приостановлен.
          <p>Уже перенесённые треки не будут добавлены повторно после проверки.</p>
        </div>
      )}
      <section className="panel">
        {active === 1 && (
          <>
            <div className="panel-heading">
              <span className="kicker">ШАГ 1 ИЗ 6</span>
              <h2>Подключите аккаунты</h2>
              <p>Проверим доступ к вашей музыке и месту назначения.</p>
            </div>
            <div className="account-grid">
              {(['spotify', 'soundcloud'] as const).map((provider) => (
                <div className="account-card" key={provider}>
                  <div className={`account-icon ${provider}`}>
                    {provider === 'spotify' ? '●' : '☁'}
                  </div>
                  <div>
                    <h3>{provider === 'spotify' ? 'Spotify' : 'SoundCloud'}</h3>
                    <p>
                      {state.auth[provider].connected
                        ? 'Подключён'
                        : state.auth[provider].configured
                          ? 'Ожидает подключения'
                          : 'Нужны настройки доступа'}
                    </p>
                  </div>
                  {state.auth[provider].connected ? (
                    <span className="check">✓</span>
                  ) : (
                    <a className="button secondary" href={`/auth/${provider}`}>
                      Подключить
                    </a>
                  )}
                </div>
              ))}
            </div>
            <div className="panel-actions">
              <button
                className="primary"
                disabled={!connected || busy}
                title={!connected ? 'Сначала подключите оба аккаунта' : undefined}
                onClick={() => setStep(2)}
              >
                Продолжить <span>→</span>
              </button>
              {!connected && <small>Подключите оба аккаунта, чтобы продолжить.</small>}
            </div>
          </>
        )}
        {active === 2 && (
          <>
            <div className="panel-heading">
              <span className="kicker">ШАГ 2 ИЗ 6</span>
              <h2>Сканирование библиотеки</h2>
              <p>Сохраним снимок Spotify и резервную копию SoundCloud перед переносом.</p>
            </div>
            {state.snapshot && (
              <div className="stat-grid">
                <Stat value={state.snapshot.savedTracks.length} label="Любимых треков" />
                <Stat
                  value={state.snapshot.playlists.filter((p) => p.status === 'READY').length}
                  label="Плейлистов"
                />
                <Stat value={Object.keys(state.snapshot.tracks).length} label="Уникальных треков" />
              </div>
            )}
            {state.job.running && (
              <Progress label="Сканирование" value={state.job.done} total={state.job.total} />
            )}
            {scanned && (
              <div className="message success">
                Библиотека найдена. Резервная копия SoundCloud готова.
              </div>
            )}
            <div className="panel-actions">
              <button
                className="primary"
                disabled={busy || state.job.running}
                onClick={() => {
                  if (scanned) {
                    setMatchingRequested(true);
                    setStep(3);
                    void run(() => post('flow/match'));
                  } else void run(() => post('flow/scan'));
                }}
              >
                {scanned ? 'Найти совпадения' : 'Сканировать библиотеку'} <span>→</span>
              </button>
            </div>
          </>
        )}
        {active === 3 && (
          <>
            <div className="panel-heading">
              <span className="kicker">ШАГ 3 ИЗ 6</span>
              <h2>Подбираем совпадения</h2>
              <p>Точные совпадения и лучшие подходящие версии выбираются автоматически.</p>
            </div>
            <div className="stat-grid">
              <Stat value={countReady(state)} label="Готово к переносу" tone="green" />
              <Stat value={countSkipped(state)} label="Пропущено" tone="amber" />
            </div>
            {state.job.running && (
              <Progress label="Поиск треков" value={state.job.done} total={state.job.total} />
            )}
            {!state.job.running && state.discovery?.status === 'blocked' && (
              <div className="message warning">
                Поиск остановился. Сохранённый результат можно продолжить.
              </div>
            )}
            {!state.job.running && matched && (
              <div className="message success">
                Подбор завершён. Не найденные треки можно посмотреть отдельно.
              </div>
            )}
            <div className="panel-actions">
              <button
                className="primary"
                disabled={busy || state.job.running}
                onClick={() =>
                  matched
                    ? setStep(4)
                    : (setMatchingRequested(true), void run(() => post('flow/match')))
                }
              >
                {matched ? 'Продолжить' : 'Продолжить поиск'} <span>→</span>
              </button>
              <button className="text-button" onClick={() => setShowSkipped((v) => !v)}>
                Посмотреть пропущенные
              </button>
            </div>
            {showSkipped && <Skipped state={state} />}
          </>
        )}
        {active === 4 && (
          <>
            <div className="panel-heading">
              <span className="kicker">ШАГ 4 ИЗ 6</span>
              <h2>Всё готово к переносу</h2>
              <p>Сверим объём работы. Плейлисты будут проверены после сохранения.</p>
            </div>
            <div className="stat-grid">
              <Stat
                value={state.plan?.plannedLikes.length ?? state.snapshot?.savedTracks.length ?? 0}
                label="Любимых треков"
              />
              <Stat
                value={
                  state.plan?.playlists.length ??
                  state.snapshot?.playlists.filter((p) => p.status === 'READY').length ??
                  0
                }
                label="Плейлистов"
              />
              <Stat value={skipped} label="Пропущено" tone="amber" />
            </div>
            <div className="message neutral">
              Резервная копия и контрольные точки сохранят прогресс. Перед массовым переносом
              проверим совместимость SoundCloud.
            </div>
            <div className="panel-actions">
              <button
                className="primary"
                disabled={busy || state.job.running}
                onClick={() =>
                  state.plan ? setConfirmTransfer(true) : void run(() => post('migration/prepare'))
                }
              >
                {state.plan ? 'Начать перенос' : 'Подготовить перенос'} <span>→</span>
              </button>
            </div>
          </>
        )}
        {active === 5 && (
          <>
            <div className="panel-heading">
              <span className="kicker">ШАГ 5 ИЗ 6</span>
              <h2>
                {state.guided.running
                  ? 'Переносим вашу музыку'
                  : paused
                    ? 'Перенос приостановлен'
                    : 'Перенос'}
              </h2>
              <p>
                {state.guided.running
                  ? state.guided.phase === 'compatibility'
                    ? 'Проверяем совместимость SoundCloud…'
                    : state.guided.phase === 'reconciling'
                      ? 'Проверяем уже перенесённые треки…'
                      : state.guided.phase === 'likes'
                        ? 'Продолжаем перенос…'
                        : 'Переносим плейлисты…'
                  : 'Ваш прогресс сохранён. Продолжим с места остановки.'}
              </p>
            </div>
            <div className="progress-stack">
              <Progress label="Плейлисты" value={playlistsDone} total={playlistsTotal} />
              <Progress label="Любимые треки" value={likesDone} total={likesTotal} />
            </div>
            {(stagingPartial(state) > 0 || stagingSkipped(state) > 0) && (
              <div className="message warning">
                Резервная копия любимых треков создана не полностью. Это не влияет на перенос Likes.
              </div>
            )}
            {duplicateEntries.length > 0 && (
              <div className="message warning">
                {duplicateEntries.reduce((n, d) => n + d.count, 0)} повторов треков пропущено в{' '}
                {duplicateEntries.length} плейлистах. Первые вхождения сохранены, подробности
                записаны в журнал.
              </div>
            )}
            {state.journal?.status === 'RATE_LIMITED' &&
              state.journal.rateLimit?.upstreamStatus === 429 &&
              retryMinutes > 0 && (
                <p>Попробуйте продолжить позже. Уже перенесённая музыка сохранена.</p>
              )}
            <div className="panel-actions">
              {!state.guided.running && (
                <button
                  className="primary"
                  disabled={busy || retryMinutes > 0}
                  title={
                    retryMinutes > 0 ? `Можно продолжить через ${retryMinutes} мин.` : undefined
                  }
                  onClick={() => void run(() => post('flow/transfer', { confirmed: true }))}
                >
                  {transferStarted ? 'Продолжить перенос' : 'Начать перенос'} <span>→</span>
                </button>
              )}
              {state.guided.running && (
                <button
                  className="secondary"
                  onClick={() => void run(() => post('migration/pause'))}
                >
                  Пауза
                </button>
              )}
            </div>
          </>
        )}
        {active === 6 && (
          <>
            <div className="done-symbol">✓</div>
            <div className="panel-heading">
              <span className="kicker">ШАГ 6 ИЗ 6</span>
              <h2>Перенос завершён</h2>
              <p>Ваша музыка доступна в SoundCloud.</p>
            </div>
            <div className="stat-grid">
              <Stat
                value={`${playlistsDone} / ${playlistsTotal}`}
                label="Плейлистов"
                tone="green"
              />
              <Stat value={`${likesDone} / ${likesTotal}`} label="Любимых треков" tone="green" />
              <Stat value={skipped} label="Пропущено" tone="amber" />
            </div>
            <div className="panel-actions">
              <a
                className="button primary"
                href="https://soundcloud.com/"
                target="_blank"
                rel="noreferrer"
              >
                Открыть SoundCloud ↗
              </a>
              <button className="text-button" onClick={() => setShowSkipped((v) => !v)}>
                Посмотреть пропущенные
              </button>
            </div>
            {showSkipped && <Skipped state={state} />}
          </>
        )}
      </section>
      <details className="advanced">
        <summary>Дополнительно</summary>
        <div className="advanced-body">
          <h3>Настройки подбора</h3>
          <p>
            Обычный режим выбирает лучшие подходящие совпадения. Безопасный режим берёт только
            подтверждённые.
          </p>
          <div className="segmented">
            <button
              disabled={busy || !!state.plan || !state.aggressive}
              className={!safeChosen ? 'selected' : ''}
              onClick={() => {
                setSafeChosen(false);
                void run(() => post('matching/mode', { mode: 'AGGRESSIVE_BEST_MATCH' }));
              }}
            >
              Обычный
            </button>
            <button
              disabled={busy || !!state.plan}
              className={safeChosen ? 'selected' : ''}
              onClick={() => {
                setSafeChosen(true);
                setMatchingRequested(false);
                void run(() => post('matching/mode', { mode: 'STRICT' }));
              }}
            >
              Безопасный
            </button>
          </div>
          <details>
            <summary>Диагностика</summary>
            <button
              className="secondary"
              onClick={() =>
                void run(async () => {
                  const r = await fetch('/api/soundcloud/me');
                  if (!r.ok) throw new Error('Diagnostics unavailable');
                  setDiagnostic(await r.json());
                })
              }
            >
              Проверить подключение
            </button>
            {diagnostic !== null && <pre>{JSON.stringify(diagnostic, null, 2)}</pre>}
          </details>
          <details>
            <summary>Технические подробности</summary>
            <pre>
              {JSON.stringify(
                {
                  discoveryHistoricalError: state.discovery?.historicalError || null,
                  matching: state.aggressive,
                  job: state.job,
                  guided: state.guided,
                  journal: state.journal,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </div>
      </details>
      {confirmTransfer && (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
            <h2 id="confirm-title">Перенести {playlistsTotal} плейлистов?</h2>
            <p>
              Мы проверим совместимость, перенесём плейлисты и любимые треки. Прогресс можно
              приостановить.
            </p>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setConfirmTransfer(false)}>
                Отмена
              </button>
              <button
                className="primary"
                onClick={() => {
                  setConfirmTransfer(false);
                  setStep(5);
                  void run(() => post('flow/transfer', { confirmed: true }));
                }}
              >
                Продолжить
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function Stat({
  value,
  label,
  tone = '',
}: {
  value: number | string;
  label: string;
  tone?: string;
}) {
  return (
    <div className={`stat ${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
function Progress({ label, value, total }: { label: string; value: number; total: number }) {
  return (
    <div className="progress-row">
      <div>
        <strong>{label}</strong>
        <span>
          {value} / {total}
        </span>
      </div>
      <progress value={value} max={Math.max(total, 1)} />
    </div>
  );
}
function Skipped({ state }: { state: State }) {
  const ids =
    state.plan?.notFound ||
    Object.entries(state.discovery?.mappings || {})
      .filter(([, m]) => !!m.processedAt && !m.acceptedUrn)
      .map(([id]) => id);
  return (
    <div className="skipped">
      <h3>Пропущенные треки</h3>
      {ids.length ? (
        <ul>
          {ids.slice(0, 100).map((id) => (
            <li key={id}>
              {state.snapshot?.tracks[id]?.title || 'Недоступный трек'}
              {state.snapshot?.tracks[id]?.artists?.[0]
                ? ` · ${state.snapshot.tracks[id].artists[0]}`
                : ''}
            </li>
          ))}
        </ul>
      ) : (
        <p>Пропущенных треков нет.</p>
      )}
      {ids.length > 100 && <p>Показаны первые 100 треков.</p>}
    </div>
  );
}
