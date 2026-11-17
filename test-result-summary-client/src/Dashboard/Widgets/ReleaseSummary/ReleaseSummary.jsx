import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
    Alert,
    Collapse,
    Empty,
    List,
    Progress,
    Select,
    Spin,
    Tag,
    Tooltip,
} from 'antd';
import {
    CheckCircleOutlined,
    ClockCircleOutlined,
    ExclamationCircleOutlined,
    LoadingOutlined,
    MinusCircleOutlined,
    StarFilled,
} from '@ant-design/icons';
import moment from 'moment';
import { fetchData } from '../../../utils/Utils';
import { params } from '../../../utils/query';
import {
    PIPELINE_REGEX,
    RELEASE_PLAN_COMMITS_URL,
    buildPlatforms,
    dockerVersionTag,
    getReleaseName,
    getSourceTag,
    githubCommitUrl,
    parsePublishedPlatforms,
    parseCommit,
    parseReleasePlan,
    parseReleasePlanRevisions,
    paramValue,
    pipelineRepo,
    releaseNextSteps,
    releasePlanUrl,
    verifySourceTag,
    summarizeContainers,
    summarizeInstallers,
    summarizeLinuxInstallers,
    summarizePlatforms,
    summarizeReleaseNotes,
    toPlatformKey,
} from './releaseUtils';
import './ReleaseSummary.css';

const ADOPTIUM_API = 'https://api.adoptium.net/v3/assets/release_name/eclipse';
const RELEASE_NOTES_API = 'https://api.adoptium.net/v3/info/release_notes';
const REFRESH_MS = 5 * 60 * 1000;
const PIPELINE_HISTORY = 10;

const STATE_COLORS = {
    published: '#2cbe4e',
    ready: '#1677ff',
    triage: '#f50',
    inprogress: '#DAA520',
};

const childBuilds = (parentId, buildNameRegex) =>
    fetchData(`/api/getAllChildBuilds${params({ parentId, buildNameRegex })}`);

// The Adoptium API sends CORS headers, so published binaries can be queried
// from the browser. A 404 simply means the release is not published yet.
const fetchPublished = async (releaseName) => {
    if (!releaseName) return null;
    try {
        const response = await fetch(
            `${ADOPTIUM_API}/${encodeURIComponent(
                releaseName
            )}?image_type=jdk&page_size=50`
        );
        if (response.status === 404) return {};
        if (!response.ok) return null;
        return parsePublishedPlatforms(await response.json());
    } catch (e) {
        console.error(e);
        return null;
    }
};

// Returns null when the API cannot be reached (status unknown). A 404 means
// the release notes are not published yet.
const fetchReleaseNotes = async (releaseName) => {
    if (!releaseName) return null;
    try {
        const response = await fetch(
            `${RELEASE_NOTES_API}/${encodeURIComponent(releaseName)}`
        );
        if (response.status === 404) {
            return summarizeReleaseNotes(releaseName, null);
        }
        if (!response.ok) return null;
        return summarizeReleaseNotes(releaseName, await response.json());
    } catch (e) {
        console.error(e);
        return null;
    }
};

// The file history and each revision are cached because they are shared by
// all pipelines (a revision never changes). GitHub limits unauthenticated API
// requests, so the history is only requested again after REFRESH_MS.
let revisionsCache = null;
const planCache = new Map();

const fetchJson = async (url, what) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${what}: HTTP ${response.status}`);
    return response;
};

const getRevisions = () => {
    if (!revisionsCache || Date.now() - revisionsCache.at > REFRESH_MS) {
        const promise = fetchJson(RELEASE_PLAN_COMMITS_URL, 'commits')
            .then((r) => r.json())
            .then(parseReleasePlanRevisions);
        revisionsCache = { at: Date.now(), promise };
        promise.catch(() => {
            if (revisionsCache && revisionsCache.promise === promise) {
                revisionsCache = null;
            }
        });
    }
    return revisionsCache.promise;
};

const loadPlan = (sha) => {
    if (!planCache.has(sha)) {
        const promise = fetchJson(releasePlanUrl(sha), 'releasePlan.cfg')
            .then((r) => r.text())
            .then(parseReleasePlan);
        planCache.set(sha, promise);
        promise.catch(() => planCache.delete(sha));
    }
    return planCache.get(sha);
};

// Resolves a tag (or branch) of an adoptium repo to its commit and parents.
// Returns null when it does not exist. A tag does not move, so it is cached.
const commitCache = new Map();

const resolveTag = (repo, ref) => {
    const key = `${repo}/${ref}`;
    if (!commitCache.has(key)) {
        const promise = fetch(githubCommitUrl(repo, ref)).then(
            async (response) => {
                // 404 or 422: no commit for this ref
                if (response.status === 404 || response.status === 422) {
                    return null;
                }
                if (!response.ok) {
                    throw new Error(`commit ${ref}: HTTP ${response.status}`);
                }
                return parseCommit(await response.json());
            }
        );
        commitCache.set(key, promise);
        promise.catch(() => commitCache.delete(key));
    }
    return commitCache.get(key);
};

// Checks the pipeline's source tag against the -ga tag in the releasePlan.cfg
// revision that relates to it. Returns null when releasePlan.cfg or GitHub
// cannot be read.
const fetchReleasePlan = async (parent) => {
    try {
        return await verifySourceTag({
            revisions: await getRevisions(),
            repo: pipelineRepo(parent.buildName),
            tag: (paramValue(parent, 'scmReference') || '').trim(),
            startTime: parent.timestamp,
            loadPlan,
            resolveTag,
        });
    } catch (e) {
        console.error(e);
        return null;
    }
};

const fetchTckResults = async (jckBuilds) => {
    const results = [];
    await Promise.all(
        (jckBuilds || []).map(async (jck) => {
            if (!jck.buildUrl || !jck.buildNum) return;
            const baseUrl = jck.buildUrl.replace(/\/job\/[^/]+\/\d+\/?$/, '');
            const remote = await fetchData(
                `/api/getRemoteJckBuildInfo${params({
                    url: baseUrl,
                    buildName: jck.buildName,
                    buildNum: jck.buildNum,
                })}`
            );
            if (!Array.isArray(remote)) return;
            remote.forEach(({ target, platform, buildResult, remoteUrl }) => {
                const key = toPlatformKey(platform);
                if (key && target) {
                    results.push({
                        key,
                        target,
                        buildResult: buildResult || null,
                        url: remoteUrl || jck.buildUrl,
                    });
                }
            });
        })
    );
    return results;
};

const loadPipelines = async () => {
    const lists = await Promise.all(
        ['Build', 'Test'].map((type) =>
            fetchData(`/api/getTopLevelBuildNames?type=${type}`)
        )
    );
    const seen = new Set();
    const names = [];
    lists.forEach((list) =>
        (Array.isArray(list) ? list : []).forEach(({ _id }) => {
            const key = `${_id.url}|${_id.buildName}`;
            if (PIPELINE_REGEX.test(_id.buildName) && !seen.has(key)) {
                seen.add(key);
                names.push(_id);
            }
        })
    );
    names.sort((a, b) =>
        b.buildName.localeCompare(a.buildName, undefined, { numeric: true })
    );
    const groups = await Promise.all(
        names.map(async ({ url, buildName }) => {
            const builds = await fetchData(
                `/api/getBuildHistory${params({
                    buildName,
                    url,
                    limit: PIPELINE_HISTORY,
                })}`
            );
            return {
                label: buildName,
                options: (Array.isArray(builds) ? builds : []).map((b) => ({
                    value: b._id,
                    label: `${buildName} #${b.buildNum}${
                        b.timestamp
                            ? ` (${moment(b.timestamp).format('MMM DD YYYY')})`
                            : ''
                    }`,
                })),
            };
        })
    );
    return groups.filter((g) => g.options.length);
};

const loadRelease = async (parentId) => {
    const [parentRes, sdkBuilds, testBuilds, installerBuilds, jckBuilds] =
        await Promise.all([
            fetchData(`/api/getData?_id=${parentId}`),
            childBuilds(parentId, '^(jdk[0-9]{1,2}|jdk-|Build_)'),
            childBuilds(parentId, '^(Test|Perf)_openjdk.*'),
            childBuilds(parentId, '(create_installer|sign_installer)'),
            childBuilds(parentId, '^AQA_Test_Pipeline_JCK$'),
        ]);
    const asList = (v) => (Array.isArray(v) ? v : []);
    const parent = (parentRes && parentRes[0]) || null;
    if (!parent) return null;

    const sdk = asList(sdkBuilds);
    const tests = asList(testBuilds);
    const releaseName = getReleaseName(parent, [...sdk, ...tests]);
    const [published, releaseNotes, releasePlan, linuxInstallers] =
        await Promise.all([
            fetchPublished(releaseName),
            fetchReleaseNotes(releaseName),
            fetchReleasePlan(parent),
            releaseName
                ? fetchData(
                      `/api/getLinuxInstallerBuilds?tag=${encodeURIComponent(
                          releaseName
                      )}`
                  )
                : null,
        ]);
    const version = dockerVersionTag(releaseName);
    const docker = version
        ? await fetchData(`/api/getDockerTags?name=${version}-jdk`)
        : null;

    return {
        parent,
        sdkBuilds: sdk,
        testBuilds: tests,
        installerBuilds: asList(installerBuilds),
        jckBuilds: asList(jckBuilds),
        releaseName,
        version,
        published,
        releaseNotes,
        releasePlan,
        linuxInstallers,
        dockerTags: docker && Array.isArray(docker.tags) ? docker.tags : null,
    };
};

const StateIcon = ({ state }) => {
    const style = { color: STATE_COLORS[state], marginRight: 6 };
    if (state === 'published' || state === 'ready') {
        return <CheckCircleOutlined style={style} />;
    }
    if (state === 'triage') return <ExclamationCircleOutlined style={style} />;
    return <ClockCircleOutlined style={style} />;
};

const BuildLinks = ({ platform }) => (
    <span className="release-summary-links">
        {platform.jdk && (
            <a href={platform.jdk.buildUrl} target="_blank" rel="noreferrer">
                JDK build
            </a>
        )}
    </span>
);

const PlatformItem = ({ platform, showFailures }) => (
    <List.Item>
        <div className="release-summary-platform">
            <div>
                <StateIcon state={platform.state} />
                <strong>{platform.label}</strong>
                {platform.primary && (
                    <Tooltip title="Primary platform (prioritized)">
                        <StarFilled className="release-summary-primary" />
                    </Tooltip>
                )}
                <span className="release-summary-aqa">
                    AQA {platform.aqa.passed}/{platform.aqa.total} passed
                </span>
                <BuildLinks platform={platform} />
            </div>
            {platform.reasons.length > 0 && (
                <div className="release-summary-reasons">
                    {platform.reasons.join('; ')}
                </div>
            )}
            {showFailures && (
                <ul className="release-summary-failures">
                    {platform.jdkKind === 'fail' && platform.jdk && (
                        <li>
                            <a
                                href={platform.jdk.buildUrl}
                                target="_blank"
                                rel="noreferrer"
                            >
                                {platform.jdk.buildName}
                            </a>{' '}
                            {platform.jdk.buildResult}
                        </li>
                    )}
                    {platform.aqa.failedBuilds.map((b) => (
                        <li key={b.name}>
                            <a href={b.url} target="_blank" rel="noreferrer">
                                {b.name}
                            </a>{' '}
                            {b.result}
                            {b.rerun && ' (after rerun)'}
                        </li>
                    ))}
                    {platform.tckFailed.map((t, i) => (
                        <li key={`${t.target}-${i}`}>
                            <a href={t.url} target="_blank" rel="noreferrer">
                                TCK {t.target}
                            </a>{' '}
                            {t.buildResult}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    </List.Item>
);

const PlatformPanel = ({ platforms, showFailures, empty }) =>
    platforms.length ? (
        <List
            size="small"
            dataSource={platforms}
            renderItem={(platform) => (
                <PlatformItem
                    key={platform.key}
                    platform={platform}
                    showFailures={showFailures}
                />
            )}
        />
    ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={empty} />
    );

const StatusTag = ({ status, labels }) => {
    const map = {
        published: { color: 'success', icon: <CheckCircleOutlined /> },
        partial: { color: 'warning', icon: <ClockCircleOutlined /> },
        pending: { color: 'default', icon: <ClockCircleOutlined /> },
        na: { color: 'default', icon: <MinusCircleOutlined /> },
    };
    const { color, icon } = map[status] || map.pending;
    return (
        <Tag color={color} icon={icon}>
            {labels[status]}
        </Tag>
    );
};

const LINUX_TAGS = {
    published: { color: 'success', text: 'published' },
    warning: { color: 'warning', text: 'finished with warnings' },
    failed: { color: 'error', text: 'failed' },
    inprogress: { color: 'processing', text: 'running' },
    pending: { color: 'default', text: 'not published' },
};

const LinuxInstallers = ({ linux }) => (
    <div className="release-summary-linux">
        <span>Linux packages (RPM / DEB / APK) </span>
        {linux.status === 'unavailable' ? (
            <Tag>Status unavailable</Tag>
        ) : (
            <>
                <StatusTag
                    status={linux.status}
                    labels={{
                        published: 'Published',
                        partial: 'Partially published',
                        pending: 'Not published',
                        na: 'No Linux platforms',
                    }}
                />
                <div>
                    {linux.expected.map((p) => {
                        const { color, text } = LINUX_TAGS[p.state];
                        return (
                            <Tag key={p.key} color={color} title={text}>
                                {p.url ? (
                                    <a
                                        href={p.url}
                                        target="_blank"
                                        rel="noreferrer"
                                    >
                                        {p.label}
                                    </a>
                                ) : (
                                    p.label
                                )}
                            </Tag>
                        );
                    })}
                </div>
            </>
        )}
    </div>
);

const Installers = ({ installers, linux, publishedKnown }) => (
    <div className="release-summary-section">
        <div className="release-summary-section-title">
            Installers{' '}
            {publishedKnown ? (
                <StatusTag
                    status={installers.status}
                    labels={{
                        published: 'Published',
                        partial: 'Partially published',
                        pending: 'Not published',
                        na: 'No installer platforms',
                    }}
                />
            ) : (
                <Tag>Publish status unavailable</Tag>
            )}
        </div>
        {installers.expected.map((p) => (
            <Tag
                key={p.key}
                color={p.published ? 'success' : 'default'}
                title="Windows MSI / macOS PKG"
            >
                {p.label}
            </Tag>
        ))}
        <LinuxInstallers linux={linux} />
        {installers.jobs.length > 0 && (
            <ul className="release-summary-failures">
                {installers.jobs.map((job) => (
                    <li key={job.name}>
                        {job.name}: {job.passed}/{job.total} passed
                        {job.failed > 0 && `, ${job.failed} failed`}
                        {job.inProgress > 0 && `, ${job.inProgress} running`}
                    </li>
                ))}
            </ul>
        )}
    </div>
);

const Containers = ({ containers, loaded }) => (
    <div className="release-summary-section">
        <div className="release-summary-section-title">
            Containers{' '}
            {loaded ? (
                <StatusTag
                    status={containers.status}
                    labels={{
                        published: 'Published',
                        pending: 'Not published',
                    }}
                />
            ) : (
                <Tag>Publish status unavailable</Tag>
            )}
        </div>
        {containers.status === 'published' && (
            <>
                <div>
                    {containers.platforms.map((p) => (
                        <Tag key={p}>{p}</Tag>
                    ))}
                </div>
                <div className="release-summary-reasons">
                    {containers.tags.length} eclipse-temurin tag(s) on Docker
                    Hub
                </div>
            </>
        )}
    </div>
);

const ReleaseNotes = ({ releaseNotes, releaseName }) => (
    <div className="release-summary-section">
        <div className="release-summary-section-title">
            Release Notes{' '}
            {releaseNotes ? (
                <StatusTag
                    status={releaseNotes.status}
                    labels={{
                        published: 'Published',
                        pending: 'Not published',
                    }}
                />
            ) : (
                <Tag>Publish status unavailable</Tag>
            )}
        </div>
        {releaseNotes && releaseNotes.status === 'published' && (
            <div className="release-summary-reasons">
                {releaseNotes.count} item(s) |{' '}
                <a href={releaseNotes.url} target="_blank" rel="noreferrer">
                    View on adoptium.net
                </a>
            </div>
        )}
        {!releaseName && (
            <div className="release-summary-reasons">
                Release name could not be determined
            </div>
        )}
    </div>
);

const RELATIONS = {
    tag: 'the same tag as',
    sha: 'the same commit as',
    merge: 'a merge of',
};

const PlanRevisionLink = ({ revision }) => (
    <>
        releasePlan.cfg{' '}
        <a href={revision.url} target="_blank" rel="noreferrer">
            {revision.sha.slice(0, 7)}
        </a>{' '}
        ({moment(revision.time).format('MMM DD YYYY')})
    </>
);

const PlanCheck = ({ source }) => {
    const { status, revision, plannedTag, relation, commit, repo } = source;
    const tagStyle = { marginLeft: 8 };
    if (status === 'verified') {
        return (
            <div>
                <Tag color="success" icon={<CheckCircleOutlined />}>
                    Matches planned {plannedTag}
                </Tag>
                {commit && `commit ${commit.sha.slice(0, 7)} is `}
                {RELATIONS[relation]} {plannedTag} in{' '}
                <PlanRevisionLink revision={revision} />
            </div>
        );
    }
    if (status === 'differs') {
        return (
            <div>
                <Tag color="warning" icon={<ExclamationCircleOutlined />}>
                    Does not match planned {plannedTag}
                </Tag>
                {commit && `commit ${commit.sha.slice(0, 7)} | `}
                planned in <PlanRevisionLink revision={revision} />
            </div>
        );
    }
    if (status === 'planned') {
        return (
            <div>
                planned in <PlanRevisionLink revision={revision} />
            </div>
        );
    }
    if (status === 'unresolved') {
        return (
            <Tag color="warning" style={tagStyle}>
                Tag not found in adoptium/{repo}
            </Tag>
        );
    }
    if (status === 'notfound') {
        return (
            <Tag style={tagStyle}>
                No planned tag in recent releasePlan.cfg revisions
            </Tag>
        );
    }
    return <Tag style={tagStyle}>releasePlan.cfg check unavailable</Tag>;
};

const SourceTag = ({ source }) => {
    if (!source) {
        return (
            <div className="release-summary-reasons">
                Source tag could not be determined
            </div>
        );
    }
    return (
        <div className="release-summary-reasons">
            Building source tag:{' '}
            {source.url ? (
                <a href={source.url} target="_blank" rel="noreferrer">
                    {source.tag}
                </a>
            ) : (
                source.tag
            )}
            {source.repo && ` (adoptium/${source.repo})`}
            <PlanCheck source={source} />
        </div>
    );
};

const NextSteps = ({ steps }) => (
    <div className="release-summary-section">
        <div className="release-summary-section-title">
            Remaining activities
        </div>
        {steps.length ? (
            <ul className="release-summary-failures">
                {steps.map((step) => (
                    <li key={step}>{step}</li>
                ))}
            </ul>
        ) : (
            <div className="release-summary-reasons">
                All platforms, installers, containers and release notes are
                published. The release is complete.
            </div>
        )}
    </div>
);

const Release = ({ data, tckResults }) => {
    const {
        parent,
        releaseName,
        published,
        releaseNotes,
        releasePlan,
        dockerTags,
    } = data;
    const platforms = buildPlatforms({
        sdkBuilds: data.sdkBuilds,
        testBuilds: data.testBuilds,
        tckResults,
        published: published || {},
    });
    const counts = summarizePlatforms(platforms);
    const by = (state) => platforms.filter((p) => p.state === state);
    const installers = summarizeInstallers({
        installerBuilds: data.installerBuilds,
        platforms,
        published: published || {},
    });
    const linuxInstallers = summarizeLinuxInstallers({
        platforms,
        releaseName,
        response: data.linuxInstallers,
    });
    const containers = summarizeContainers(data.version, dockerTags || []);
    const source = getSourceTag(parent, releasePlan);
    const steps = releaseNextSteps({
        counts,
        platforms,
        installers,
        linux: linuxInstallers,
        containers,
        releaseNotes,
        publishedKnown: published !== null,
        containersKnown: dockerTags !== null,
    });

    return (
        <div>
            <div className="release-summary-header">
                <a href={parent.buildUrl} target="_blank" rel="noreferrer">
                    {parent.buildName} #{parent.buildNum}
                </a>{' '}
                <Link
                    to={{
                        pathname: '/resultSummary',
                        search: params({ parentId: parent._id }),
                    }}
                >
                    Grid
                </Link>
                <SourceTag source={source} />
                <div className="release-summary-reasons">
                    {releaseName ? (
                        <>Release: {releaseName}</>
                    ) : (
                        'Release name could not be determined, so published status is unavailable'
                    )}
                    {parent.timestamp &&
                        ` | Started ${moment(parent.timestamp).format(
                            'MMM DD YYYY, hh:mm a'
                        )}`}
                </div>
            </div>
            {published === null && releaseName && (
                <Alert
                    type="warning"
                    showIcon
                    message="Could not reach the Adoptium API; published status is unavailable."
                />
            )}
            <Tooltip
                title={`${counts.total} platforms: ${counts.published} published, ${counts.ready} ready to publish, ${counts.triage} need triage, ${counts.inprogress} in progress`}
            >
                <Progress
                    percent={counts.percentReady}
                    success={{ percent: counts.percentPublished }}
                    strokeColor={STATE_COLORS.ready}
                    format={() => `${counts.percentPublished}% published`}
                />
            </Tooltip>
            <div className="release-summary-counts">
                <Tag>
                    {counts.total} platform{counts.total === 1 ? '' : 's'} in
                    this pipeline run
                </Tag>
                <Tag color="success">{counts.published} published</Tag>
                <Tag color="processing">{counts.ready} ready</Tag>
                <Tag color="error">{counts.triage} triage</Tag>
                <Tag color="warning">{counts.inprogress} in progress</Tag>
            </div>
            <Collapse>
                <Collapse.Panel
                    key="inprogress"
                    header={`Platforms In Progress (${counts.inprogress})`}
                >
                    <PlatformPanel
                        platforms={by('inprogress')}
                        empty="Nothing in progress"
                    />
                </Collapse.Panel>
                <Collapse.Panel
                    key="triage"
                    header={`Platforms Requiring Triage (${counts.triage})`}
                >
                    <PlatformPanel
                        platforms={by('triage')}
                        showFailures
                        empty="No platforms require triage"
                    />
                </Collapse.Panel>
                <Collapse.Panel
                    key="ready"
                    header={`Platforms Ready to Publish (${counts.ready})`}
                >
                    <PlatformPanel
                        platforms={by('ready')}
                        empty="No platforms are waiting to be published"
                    />
                </Collapse.Panel>
                <Collapse.Panel
                    key="published"
                    header={`Platforms Published (${counts.published})`}
                >
                    <PlatformPanel
                        platforms={by('published')}
                        empty="No platforms published yet"
                    />
                </Collapse.Panel>
            </Collapse>
            <Installers
                installers={installers}
                linux={linuxInstallers}
                publishedKnown={published !== null}
            />
            <Containers containers={containers} loaded={dockerTags !== null} />
            <ReleaseNotes
                releaseNotes={releaseNotes}
                releaseName={releaseName}
            />
            <NextSteps steps={steps} />
        </div>
    );
};

const ReleaseSummary = ({ pipelineSelected, onChange }) => {
    const [options, setOptions] = useState(null);
    const [data, setData] = useState(null);
    const [tckResults, setTckResults] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const requestId = useRef(0);

    useEffect(() => {
        let cancelled = false;
        loadPipelines().then((groups) => {
            if (!cancelled) setOptions(groups);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    const load = useCallback(async (parentId, silent) => {
        const id = ++requestId.current;
        if (!silent) setLoading(true);
        setError(null);
        try {
            const release = await loadRelease(parentId);
            if (id !== requestId.current) return;
            if (!release) {
                setData(null);
                setError(`Cannot find build ${parentId} in the database`);
                return;
            }
            setData(release);
            setTckResults([]);
            // JCK results come from remote console logs; patch them in later
            // so a slow remote Jenkins never blocks the rest of the widget.
            fetchTckResults(release.jckBuilds).then((results) => {
                if (id === requestId.current) setTckResults(results);
            });
        } catch (e) {
            console.error(e);
            if (id === requestId.current) {
                setError('Failed to load release information');
            }
        } finally {
            if (id === requestId.current) setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!pipelineSelected) {
            requestId.current++;
            setData(null);
            return undefined;
        }
        load(pipelineSelected);
        const intervalId = setInterval(
            () => load(pipelineSelected, true),
            REFRESH_MS
        );
        return () => clearInterval(intervalId);
    }, [pipelineSelected, load]);

    const onSelect = (value, option) => {
        onChange({ pipelineSelected: value, pipelineLabel: option.label });
    };

    return (
        <div className="release-summary">
            <Select
                showSearch
                allowClear
                style={{ width: '100%', marginBottom: 8 }}
                placeholder="Select a release pipeline"
                loading={!options}
                options={options || []}
                value={pipelineSelected}
                optionFilterProp="label"
                onSelect={onSelect}
                onClear={() =>
                    onChange({
                        pipelineSelected: undefined,
                        pipelineLabel: undefined,
                    })
                }
                notFoundContent={
                    options ? (
                        'No release pipelines found'
                    ) : (
                        <Spin size="small" />
                    )
                }
            />
            {!pipelineSelected && (
                <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="Select a release pipeline to see its summary"
                />
            )}
            {pipelineSelected && loading && !data && (
                <Spin indicator={<LoadingOutlined />} />
            )}
            {error && <Alert type="error" showIcon message={error} />}
            {pipelineSelected && data && (
                <Release data={data} tckResults={tckResults} />
            )}
        </div>
    );
};

ReleaseSummary.Title = (props) =>
    props.pipelineLabel
        ? `Release Summary: ${props.pipelineLabel}`
        : 'Release Summary';
ReleaseSummary.defaultSize = { w: 2, h: 6 };
ReleaseSummary.defaultSettings = {};

export default ReleaseSummary;
