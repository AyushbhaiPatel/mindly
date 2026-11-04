import { useState } from 'react';
import { Confirm, Empty, Loaded, Mono, Panel } from '../components/ui';
import { useAction, useApp, useResource } from '../state';

export function SettingsView() {
  const { client, project } = useApp();
  const res = useResource(() => client.trust(project.id), [project.id]);
  const { busy, run } = useAction();
  const [confirm, setConfirm] = useState(false);

  return (
    <div className="view">
      <Panel title="Project">
        <dl className="kv">
          <dt>Name</dt>
          <dd>{project.name}</dd>
          <dt>Root</dt>
          <dd>
            <Mono>{project.root}</Mono>
          </dd>
          <dt>Id</dt>
          <dd>
            <Mono>{project.id}</Mono>
          </dd>
        </dl>
      </Panel>
      <Panel title="Config trust">
        <Loaded res={res}>
          {(t) => (
            <div className="stack-lg">
              <div
                className={t.trusted ? 'trust-state trust-ok' : 'trust-state trust-no'}
                role="status"
              >
                <span className="trust-state-mark" aria-hidden="true">
                  {t.trusted ? '✓' : '!'}
                </span>
                <div>
                  <p className="trust-state-title">
                    {t.trusted ? 'This config is trusted' : 'This config is not trusted'}
                  </p>
                  <p className="small">
                    {t.trusted
                      ? 'Synapse runs the checks below during shadow merges and replays.'
                      : 'Synapse will not run any command from this repository’s .synapse/config.json until you trust it. Shadow merges still merge, but skip checks.'}
                  </p>
                </div>
              </div>
              {t.configError && (
                <p className="error-note" role="alert">
                  .synapse/config.json is invalid: {t.configError}
                </p>
              )}
              <dl className="kv">
                <dt>Config hash</dt>
                <dd>
                  {t.configHash ? (
                    <Mono>{t.configHash}</Mono>
                  ) : (
                    <span className="muted">no config file</span>
                  )}
                </dd>
                <dt>Trusted hash</dt>
                <dd>
                  {project.trustedConfigHash ? (
                    <Mono>{project.trustedConfigHash}</Mono>
                  ) : (
                    <span className="muted">none</span>
                  )}
                  {project.trustedConfigHash &&
                    t.configHash &&
                    project.trustedConfigHash !== t.configHash && (
                      <span className="tag tone-warn">config changed since you trusted it</span>
                    )}
                </dd>
              </dl>
              <section aria-label="Checks">
                <h3 className="sub">Checks defined in .synapse/config.json</h3>
                {t.checks.length === 0 ? (
                  <Empty>No checks defined.</Empty>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th scope="col">Name</th>
                          <th scope="col">Command (argv, no shell)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {t.checks.map((c) => (
                          <tr key={c.name}>
                            <th scope="row">
                              <Mono>{c.name}</Mono>
                            </th>
                            <td>
                              <span className="argv">
                                {c.argv.map((a, i) => (
                                  <code key={i} className="mono argv-part">
                                    {a}
                                  </code>
                                ))}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
              {!t.trusted && (
                <div className="warn-box">
                  <p>
                    <strong>These commands will run on this machine</strong> with your user’s
                    permissions whenever Synapse runs a shadow merge or replay. A repository can put
                    anything in its config, so read each command above. Trust is tied to this exact
                    config; if the file changes, Synapse asks again.
                  </p>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={!!busy || !!t.configError}
                    onClick={() => setConfirm(true)}
                  >
                    Trust this config
                  </button>
                </div>
              )}
              <Confirm
                open={confirm}
                title="Trust this config and allow its commands to run?"
                confirmLabel="Trust and allow"
                danger
                onCancel={() => setConfirm(false)}
                onConfirm={() => {
                  setConfirm(false);
                  void run('trust', () => client.trustConfig(project.id), 'Config trusted').then(
                    (ok) => ok && res.reload(),
                  );
                }}
              >
                <p>
                  {t.checks.length} command{t.checks.length === 1 ? '' : 's'} from{' '}
                  <Mono>{project.root}/.synapse/config.json</Mono> will be allowed to run on this
                  machine.
                </p>
              </Confirm>
            </div>
          )}
        </Loaded>
      </Panel>
    </div>
  );
}
