import { useState } from 'react';
import {
  Confirm,
  CopyId,
  DataTable,
  DotWord,
  Empty,
  Facts,
  Loaded,
  Mono,
  Panel,
  type Column,
} from '../components/ui';
import { useAction, useApp, useResource } from '../state';
import type { TrustStatus } from '../types';
import { COLUMNS, EMPTY } from '../vocab';

type CheckDef = TrustStatus['checks'][number];

const checkCols: Column<CheckDef>[] = [
  { key: 'name', header: COLUMNS.name, cell: (c) => <Mono>{c.name}</Mono> },
  {
    key: 'cmd',
    header: COLUMNS.command,
    kind: 'main',
    title: (c) => c.argv.join(' '),
    cell: (c) => <Mono>{c.argv.join(' ')}</Mono>,
  },
];

export function SettingsView() {
  const { client, project, reloadProjects } = useApp();
  const res = useResource(() => client.trust(project.id), [project.id]);
  const { busy, run } = useAction();
  const [confirm, setConfirm] = useState(false);

  return (
    <div className="view">
      <Panel title="Project">
        <Facts
          items={[
            ['Name', project.name],
            ['Root', <Mono key="r">{project.root}</Mono>],
            ['Id', <CopyId key="id" id={project.id} label="project id" />],
          ]}
        />
      </Panel>
      <Loaded res={res}>
        {(t) => {
          // A trusted config is trusted at its current hash, whatever the project list read
          // earlier still says; otherwise the list holds the hash that was trusted last.
          const trustedHash = t.trusted ? t.configHash : project.trustedConfigHash;
          const changed = !!trustedHash && !!t.configHash && trustedHash !== t.configHash;
          return (
            <Panel
              title="Config trust"
              help="configTrust"
              meta={
                <DotWord tone={t.trusted ? 'good' : 'bad'}>
                  {t.trusted ? 'trusted' : 'not trusted'}
                </DotWord>
              }
              actions={
                !t.trusted ? (
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={!!busy || !!t.configError}
                    onClick={() => setConfirm(true)}
                  >
                    Trust this config
                  </button>
                ) : undefined
              }
            >
              <div className="detail-stack">
                {t.configError && (
                  <p className="error-note" role="alert">
                    .mindly/config.json is invalid: {t.configError}
                  </p>
                )}
                <Facts
                  items={[
                    [
                      'Config hash',
                      t.configHash ? (
                        <Mono>{t.configHash}</Mono>
                      ) : (
                        <span className="muted">no config file</span>
                      ),
                    ],
                    [
                      'Trusted hash',
                      trustedHash ? (
                        <>
                          <Mono>{trustedHash}</Mono>
                          {changed && (
                            <span className="warn-text"> {'·'} config changed since</span>
                          )}
                        </>
                      ) : (
                        <span className="muted">none</span>
                      ),
                    ],
                  ]}
                />
                <section aria-label="Checks">
                  <h3 className="sub">Checks in .mindly/config.json</h3>
                  {t.checks.length === 0 ? (
                    <Empty>{EMPTY.configChecks}</Empty>
                  ) : (
                    <DataTable
                      label="Checks"
                      columns={checkCols}
                      rows={t.checks}
                      rowKey={(c) => c.name}
                    />
                  )}
                </section>
                {!t.trusted && (
                  <p className="warn-text small">
                    Trusting lets these commands run on this machine with your permissions.
                  </p>
                )}
              </div>
              <Confirm
                open={confirm}
                title="Trust this config and allow its commands to run?"
                confirmLabel="Trust and allow"
                danger
                onCancel={() => setConfirm(false)}
                onConfirm={() => {
                  setConfirm(false);
                  void run(
                    'trust',
                    () => client.trustConfig(project.id, t.configHash ?? ''),
                    'Config trusted',
                  ).then((ok) => {
                    if (!ok) return;
                    res.reload();
                    // The trusted hash is stored on the project: read the list again.
                    void reloadProjects().catch(() => undefined);
                  });
                }}
              >
                <p>
                  {t.checks.length} command{t.checks.length === 1 ? '' : 's'} from{' '}
                  <Mono>{project.root}/.mindly/config.json</Mono> will be allowed to run on this
                  machine. Read each one first.
                </p>
              </Confirm>
            </Panel>
          );
        }}
      </Loaded>
    </div>
  );
}
