import {
    buildPlatforms,
    dedupeTestBuilds,
    dockerVersionTag,
    getReleaseName,
    getSourceTag,
    normalizeReleaseName,
    parsePublishedPlatforms,
    parseCommit,
    parseReleasePlan,
    parseReleasePlanRevisions,
    pipelineRepo,
    releaseNextSteps,
    parseSdkBuildName,
    parseTestBuildName,
    releaseNameFromJavaVersion,
    summarizeContainers,
    linuxInstallerPlatform,
    summarizeInstallers,
    summarizeLinuxInstallers,
    summarizePlatforms,
    summarizeReleaseNotes,
    verifySourceTag,
    toPlatformKey,
} from './releaseUtils';

const build = (buildName, buildResult = 'SUCCESS', extra = {}) => ({
    buildName,
    buildResult,
    status: 'Done',
    buildUrl: `http://jenkins/${buildName}`,
    timestamp: 1,
    ...extra,
});

describe('platform parsing', () => {
    test('toPlatformKey normalizes arch and skips variants', () => {
        expect(toPlatformKey('x86-64_linux')).toBe('x64_linux');
        expect(toPlatformKey('aarch64_alpine-linux')).toBe(
            'aarch64_alpine-linux'
        );
        expect(toPlatformKey('x86-64_linux_xl')).toBeNull();
    });

    test('parseSdkBuildName', () => {
        expect(parseSdkBuildName('jdk21u-linux-x64-temurin')).toMatchObject({
            platform: 'x64_linux',
            smoke: false,
            jdkVersion: '21',
        });
        expect(
            parseSdkBuildName('jdk21u-alpine-linux-aarch64-temurin')
        ).toMatchObject({ platform: 'aarch64_alpine-linux' });
        expect(
            parseSdkBuildName('jdk21u-windows-x86-32-temurin_SmokeTests')
        ).toMatchObject({ platform: 'x32_windows', smoke: true });
        expect(parseSdkBuildName('jdk8u-linux-arm-temurin')).toMatchObject({
            platform: 'arm_linux',
        });
        expect(parseSdkBuildName('jdk21u-linux-ppc64le-temurin')).toMatchObject(
            { platform: 'ppc64le_linux' }
        );
        expect(
            parseSdkBuildName(
                'Test_openjdk21_hs_sanity.functional_x86-64_linux'
            )
        ).toBeNull();
    });

    test('parseTestBuildName', () => {
        expect(
            parseTestBuildName(
                'Test_openjdk21_hs_sanity.functional_x86-64_linux'
            )
        ).toEqual({ platform: 'x64_linux', rerun: false });
        expect(
            parseTestBuildName(
                'Test_openjdk21_hs_extended.openjdk_aarch64_mac_rerun'
            )
        ).toEqual({ platform: 'aarch64_mac', rerun: true });
    });
});

describe('dedupeTestBuilds', () => {
    test('skips parallel children and prefers rerun result', () => {
        const name = 'Test_openjdk21_hs_sanity.functional_x86-64_linux';
        const result = dedupeTestBuilds([
            build(name, 'FAILURE'),
            build(`${name}_rerun`, 'SUCCESS', { timestamp: 2 }),
            build(`${name}_testList_0`, 'FAILURE'),
        ]);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe(name);
        expect(result[0].build.buildResult).toBe('SUCCESS');
    });
});

describe('buildPlatforms', () => {
    const sdkBuilds = [
        build('jdk21u-linux-x64-temurin'),
        build('jdk21u-mac-x64-temurin'),
        build('jdk21u-linux-aarch64-temurin', 'FAILURE'),
        build('jdk21u-aix-ppc64-temurin'),
        build('jdk21u-windows-x64-temurin'),
    ];
    const t = (platform, result = 'SUCCESS', extra) =>
        build(`Test_openjdk21_hs_sanity.functional_${platform}`, result, extra);
    const testBuilds = [
        t('x86-64_linux'),
        t('x86-64_mac'),
        t('aarch64_linux'),
        t('ppc64_aix', null, { status: 'NotDone' }),
        t('x86-64_windows', 'UNSTABLE'),
    ];

    test('classifies platforms', () => {
        const platforms = buildPlatforms({
            sdkBuilds,
            testBuilds,
            published: { x64_linux: { installer: false } },
        });
        const state = Object.fromEntries(
            platforms.map((p) => [p.key, p.state])
        );
        expect(state).toEqual({
            x64_linux: 'published',
            x64_mac: 'ready',
            aarch64_linux: 'triage',
            ppc64_aix: 'inprogress',
            x64_windows: 'triage',
        });
        expect(summarizePlatforms(platforms)).toMatchObject({
            total: 5,
            published: 1,
            ready: 1,
            triage: 2,
            inprogress: 1,
            percentPublished: 20,
            percentReady: 40,
        });
    });

    test('primary platforms sort first', () => {
        const platforms = buildPlatforms({ sdkBuilds, testBuilds });
        expect(platforms[platforms.length - 1].key).toBe('ppc64_aix');
    });

    test('platform without tests is in progress, failed TCK needs triage', () => {
        const [noTests] = buildPlatforms({
            sdkBuilds: [build('jdk21u-linux-x64-temurin')],
        });
        expect(noTests.state).toBe('inprogress');

        const [tck] = buildPlatforms({
            sdkBuilds: [build('jdk21u-linux-x64-temurin')],
            testBuilds: [t('x86-64_linux')],
            tckResults: [
                { key: 'x64_linux', target: 'dev', buildResult: 'FAILURE' },
            ],
        });
        expect(tck.state).toBe('triage');
    });

    test('smoke tests count as AQA builds', () => {
        const [p] = buildPlatforms({
            sdkBuilds: [
                build('jdk21u-linux-x64-temurin'),
                build('jdk21u-linux-x64-temurin_SmokeTests', 'FAILURE'),
            ],
            testBuilds: [t('x86-64_linux')],
        });
        expect(p.aqa).toMatchObject({ total: 2, passed: 1, failed: 1 });
        expect(p.state).toBe('triage');
    });
});

describe('published, installers and containers', () => {
    const release = {
        binaries: [
            {
                architecture: 'x64',
                os: 'mac',
                jvm_impl: 'hotspot',
                installer: {},
            },
            { architecture: 'x64', os: 'linux', jvm_impl: 'hotspot' },
            { architecture: 'x64', os: 'windows', jvm_impl: 'openj9' },
        ],
    };

    test('parsePublishedPlatforms', () => {
        expect(parsePublishedPlatforms(release)).toEqual({
            x64_mac: { installer: true },
            x64_linux: { installer: false },
        });
        expect(parsePublishedPlatforms(null)).toEqual({});
    });

    test('summarizeInstallers', () => {
        const platforms = [
            { key: 'x64_mac', label: 'x64 Mac' },
            { key: 'x64_windows', label: 'x64 Windows' },
            { key: 'x64_linux', label: 'x64 Linux' },
        ];
        const published = parsePublishedPlatforms(release);
        const result = summarizeInstallers({
            platforms,
            published,
            installerBuilds: [
                build('create_installer_mac'),
                build('create_installer_mac', 'FAILURE'),
            ],
        });
        expect(result.status).toBe('partial');
        expect(result.expected.map((p) => p.label)).toEqual([
            'x64 Mac',
            'x64 Windows',
        ]);
        expect(result.jobs).toEqual([
            expect.objectContaining({
                name: 'create_installer_mac',
                total: 2,
                passed: 1,
                failed: 1,
            }),
        ]);
        expect(summarizeInstallers({ platforms: [platforms[2]] }).status).toBe(
            'na'
        );
    });

    describe('linux installers', () => {
        const linux = (num, artifacts, result = 'SUCCESS', params = {}) =>
            build('create_installer_linux', result, {
                buildNum: num,
                buildParams: [
                    { name: 'TAG', value: params.tag || 'jdk-21.0.5+11' },
                    { name: 'ARTIFACTS_TO_COPY', value: artifacts },
                    ...Object.entries(params.flags || {}).map(
                        ([name, value]) => ({ name, value })
                    ),
                ],
            });
        const platforms = [
            { key: 'x64_linux', label: 'x64 Linux' },
            { key: 'aarch64_alpine-linux', label: 'aarch64 Alpine Linux' },
            { key: 'x64_mac', label: 'x64 Mac' },
        ];

        test('linuxInstallerPlatform', () => {
            expect(
                linuxInstallerPlatform(linux(1, 'a/linux/x64/jdk/*.tar.gz'))
            ).toBe('x64_linux');
            expect(
                linuxInstallerPlatform(
                    linux(1, 'a/alpine-linux/aarch64/jdk/*.tar.gz')
                )
            ).toBe('aarch64_alpine-linux');
            // blank runs: other OS, no arch, several archs
            expect(linuxInstallerPlatform(linux(1, 'a/mac/x64/b'))).toBeNull();
            expect(linuxInstallerPlatform(linux(1, 'a/linux/b'))).toBeNull();
            expect(
                linuxInstallerPlatform(linux(1, 'a/linux/x64/b,a/linux/arm/b'))
            ).toBeNull();
            expect(linuxInstallerPlatform({})).toBeNull();
        });

        test('unavailable when Jenkins cannot be queried', () => {
            const result = summarizeLinuxInstallers({
                platforms,
                releaseName: 'jdk-21.0.5+11',
                response: { error: 'Error: boom' },
            });
            expect(result.status).toBe('unavailable');
            expect(result.expected.map((p) => p.key)).toEqual([
                'x64_linux',
                'aarch64_alpine-linux',
            ]);
        });

        test('uses the newest run per platform and ignores other runs', () => {
            const result = summarizeLinuxInstallers({
                platforms,
                releaseName: 'jdk-21.0.5+11',
                response: {
                    builds: [
                        linux(1, 'a/linux/x64/b', 'FAILURE'),
                        linux(2, 'a/linux/x64/b', 'SUCCESS'),
                        // other release and blank run are ignored
                        linux(9, 'a/linux/x64/b', 'FAILURE', {
                            tag: 'jdk-21.0.6+7',
                        }),
                        linux(10, 'a/mac/x64/b', 'NOT_BUILT'),
                        linux(3, 'a/alpine-linux/aarch64/b', 'UNSTABLE'),
                    ],
                },
            });
            expect(result.status).toBe('partial');
            expect(result.expected.map((p) => p.state)).toEqual([
                'published',
                'warning',
            ]);
        });

        test('dry runs and skipped uploads are not published', () => {
            const result = summarizeLinuxInstallers({
                platforms,
                releaseName: 'jdk-21.0.5+11',
                response: {
                    builds: [
                        linux(1, 'a/linux/x64/b', 'SUCCESS', {
                            flags: { DRY_RUN: 'true' },
                        }),
                        linux(2, 'a/alpine-linux/aarch64/b', 'SUCCESS', {
                            flags: { SKIP_UPLOAD: 'true' },
                        }),
                    ],
                },
            });
            expect(result.status).toBe('pending');
            expect(result.expected.every((p) => p.state === 'pending')).toBe(
                true
            );
        });

        test('reports running, failed and published platforms', () => {
            const running = linux(1, 'a/linux/x64/b', null, {});
            running.status = 'NotDone';
            const result = summarizeLinuxInstallers({
                platforms,
                releaseName: 'jdk-21.0.5+11',
                response: {
                    builds: [
                        running,
                        linux(2, 'a/alpine-linux/aarch64/b', 'FAILURE'),
                    ],
                },
            });
            expect(result.expected.map((p) => p.state)).toEqual([
                'inprogress',
                'failed',
            ]);
        });
    });

    test('summarizeContainers', () => {
        const tags = [
            { name: '21.0.5_11-jdk-noble', platforms: ['linux/amd64'] },
            { name: '21.0.5_11-jre', platforms: ['linux/arm64'] },
            { name: '121.0.5_11-jdk', platforms: ['linux/s390x'] },
        ];
        expect(summarizeContainers('21.0.5_11', tags)).toEqual({
            status: 'published',
            tags: ['21.0.5_11-jdk-noble', '21.0.5_11-jre'],
            platforms: ['linux/amd64', 'linux/arm64'],
        });
        expect(summarizeContainers('21.0.5_11', []).status).toBe('pending');
    });
});

describe('release name', () => {
    test('normalizeReleaseName', () => {
        expect(normalizeReleaseName('jdk-21.0.5+11_adopt')).toBe(
            'jdk-21.0.5+11'
        );
        expect(normalizeReleaseName('jdk8u432-b06')).toBe('jdk8u432-b06');
        expect(normalizeReleaseName('jdk-21.0.5-ga')).toBeNull();
        expect(normalizeReleaseName('')).toBeNull();
    });

    test('releaseNameFromJavaVersion', () => {
        expect(
            releaseNameFromJavaVersion(
                'OpenJDK Runtime Environment Temurin-21.0.5+11 (build 21.0.5+11-LTS)'
            )
        ).toBe('jdk-21.0.5+11');
        expect(
            releaseNameFromJavaVersion(
                'OpenJDK Runtime Environment (Temurin)(build 1.8.0_432-b06)'
            )
        ).toBe('jdk8u432-b06');
        expect(releaseNameFromJavaVersion('nothing')).toBeNull();
    });

    test('getReleaseName prefers publish params then java version', () => {
        const parent = {
            buildParams: [
                { name: 'scmReference', value: 'jdk-21.0.5-ga' },
                { name: 'overridePublishName', value: 'jdk-21.0.5+11' },
            ],
        };
        expect(getReleaseName(parent, [])).toBe('jdk-21.0.5+11');
        expect(
            getReleaseName({}, [{ javaVersion: '(build 17.0.13+11-LTS)' }])
        ).toBe('jdk-17.0.13+11');
        expect(getReleaseName({}, [])).toBeNull();
    });

    test('dockerVersionTag', () => {
        expect(dockerVersionTag('jdk-21.0.5+11')).toBe('21.0.5_11');
        expect(dockerVersionTag('jdk8u432-b06')).toBe('8u432-b06');
        expect(dockerVersionTag(null)).toBeNull();
    });
});

describe('release notes', () => {
    test('summarizeReleaseNotes', () => {
        expect(
            summarizeReleaseNotes('jdk-21.0.5+11', {
                release_notes: [{ id: 'JDK-1' }, { id: 'JDK-2' }],
            })
        ).toEqual({
            status: 'published',
            count: 2,
            url: 'https://adoptium.net/temurin/release-notes?version=jdk-21.0.5%2B11',
        });
        expect(summarizeReleaseNotes('jdk-21.0.5+11', null).status).toBe(
            'pending'
        );
        expect(
            summarizeReleaseNotes('jdk-21.0.5+11', { release_notes: [] }).status
        ).toBe('pending');
    });
});

describe('source tag', () => {
    test('parseReleasePlan', () => {
        const plan = parseReleasePlan(`# comment
#jdk8u372-dryrun-ga
jdk8uGA="jdk8u514-ga"
jdk21uGA="jdk-21.0.13.1-ga"
jdk27uGA = 'jdk-27.0.1.1-ga'
`);
        expect(plan).toEqual({
            jdk8u: 'jdk8u514-ga',
            jdk21u: 'jdk-21.0.13.1-ga',
            jdk27u: 'jdk-27.0.1.1-ga',
        });
        expect(parseReleasePlan(null)).toEqual({});
    });

    test('pipelineRepo', () => {
        expect(pipelineRepo('release-openjdk21-pipeline')).toBe('jdk21u');
        expect(pipelineRepo('release-openjdk8u-pipeline')).toBe('jdk8u');
        expect(pipelineRepo('other')).toBeNull();
    });

    test('parseReleasePlanRevisions sorts newest first', () => {
        const commit = (sha, date) => ({
            sha,
            html_url: `https://github.com/c/${sha}`,
            commit: { committer: { date } },
        });
        const revisions = parseReleasePlanRevisions([
            commit('old', '2026-01-01T00:00:00Z'),
            commit('new', '2026-03-01T00:00:00Z'),
            { sha: 'bad', commit: {} },
        ]);
        expect(revisions.map((r) => r.sha)).toEqual(['new', 'old']);
        expect(revisions[0].url).toBe('https://github.com/c/new');
        expect(parseReleasePlanRevisions(null)).toEqual([]);
    });

    describe('verifySourceTag', () => {
        const day = (n) => Date.parse('2026-01-01T00:00:00Z') + n * 86400000;
        // newest first
        const revisions = [
            { sha: 'r3', time: day(30) },
            { sha: 'r2', time: day(20) },
            { sha: 'r1', time: day(10) },
        ];
        const plans = {
            r3: { jdk21u: 'jdk-21.0.13.1-ga' },
            r2: { jdk21u: 'jdk-21.0.13-ga', jdk17u: 'jdk-17.0.21-ga' },
            r1: { jdk21u: 'jdk-21.0.12-ga' },
        };
        // tag -> commit, in the way of jdk-21.0.13: the -ga tag is a commit on
        // the upstream branch and the _adopt tag merges it into the release
        const commits = {
            'jdk-21.0.13-ga': { sha: 'ga13', parents: ['x'] },
            'jdk-21.0.13+9': { sha: 'ga13', parents: ['x'] },
            'jdk-21.0.13+9_adopt': { sha: 'merge13', parents: ['rel', 'ga13'] },
            'jdk-21.0.13.1-ga': { sha: 'ga131', parents: ['y'] },
            'jdk-21.0.12-ga': { sha: 'ga12', parents: ['z'] },
            'jdk-17.0.21-ga': { sha: 'ga17', parents: ['w'] },
        };
        // not jest.fn: CRA resets mock implementations before every test
        let loaded;
        let resolved;
        const loadPlan = async (sha) => {
            loaded.push(sha);
            return plans[sha];
        };
        const resolveTag = async (repo, ref) => {
            resolved.push(ref);
            return commits[ref] || null;
        };
        beforeEach(() => {
            loaded = [];
            resolved = [];
        });
        const verify = (args) =>
            verifySourceTag({
                revisions,
                repo: 'jdk21u',
                startTime: day(40),
                loadPlan,
                resolveTag,
                ...args,
            });

        test('verifies the same tag without resolving the planned tag', async () => {
            const result = await verify({ tag: 'jdk-21.0.13-ga' });
            expect(result).toMatchObject({
                status: 'verified',
                relation: 'tag',
                plannedTag: 'jdk-21.0.13-ga',
            });
            expect(result.revision.sha).toBe('r2');
            expect(resolved).not.toContain('jdk-21.0.13.1-ga-extra');
        });

        test('verifies a different tag on the same commit', async () => {
            const result = await verify({ tag: 'jdk-21.0.13+9' });
            expect(result).toMatchObject({
                status: 'verified',
                relation: 'sha',
                plannedTag: 'jdk-21.0.13-ga',
            });
            expect(result.revision.sha).toBe('r2');
        });

        test('verifies a _adopt merge of the planned tag', async () => {
            const result = await verify({ tag: 'jdk-21.0.13+9_adopt' });
            expect(result).toMatchObject({
                status: 'verified',
                relation: 'merge',
                plannedTag: 'jdk-21.0.13-ga',
            });
            expect(result.source.sha).toBe('merge13');
        });

        test('only uses revisions from before the pipeline started', async () => {
            const result = await verify({
                tag: 'jdk-21.0.13+9_adopt',
                startTime: day(15),
            });
            // r1 plans jdk-21.0.12-ga, which the tag does not build
            expect(result.status).toBe('differs');
            expect(result.plannedTag).toBe('jdk-21.0.12-ga');
            expect(loaded).toEqual(['r1']);
        });

        test('reports the planned tag in effect when nothing matches', async () => {
            const result = await verify({ tag: 'jdk-21.0.12-ga' });
            // the newest revision is checked first but the older one matches
            expect(result.status).toBe('verified');
            expect(result.revision.sha).toBe('r1');
            const differs = await verify({
                tag: 'jdk-21.0.13.1-ga',
                startTime: day(25),
            });
            expect(differs.status).toBe('differs');
            expect(differs.plannedTag).toBe('jdk-21.0.13-ga');
            expect(differs.revision.sha).toBe('r2');
        });

        test('is unresolved when the source tag does not exist', async () => {
            const result = await verify({ tag: 'jdk-21.0.99-ga' });
            expect(result).toEqual({ status: 'unresolved' });
            expect(loaded).toEqual([]);
        });

        test('without a tag uses the newest revision that lists the repo', async () => {
            const result = await verify({ startTime: day(25) });
            expect(result.status).toBe('planned');
            expect(result.plannedTag).toBe('jdk-21.0.13-ga');
            expect(result.revision.sha).toBe('r2');
            const other = await verify({ repo: 'jdk17u', startTime: day(40) });
            expect(other.plannedTag).toBe('jdk-17.0.21-ga');
            expect(resolved).toEqual([]);
        });

        test('is not found without a repo or planned tag', async () => {
            expect((await verify({ repo: null })).status).toBe('notfound');
            expect(
                (await verify({ repo: 'jdk11u', tag: 'jdk-21.0.13-ga' })).status
            ).toBe('notfound');
        });

        test('propagates read errors', async () => {
            await expect(
                verify({
                    tag: 'jdk-21.0.13-ga',
                    loadPlan: async () => {
                        throw new Error('boom');
                    },
                })
            ).rejects.toThrow('boom');
        });
    });

    test('parseCommit', () => {
        expect(
            parseCommit({
                sha: 'abc',
                html_url: 'https://github.com/c/abc',
                parents: [{ sha: 'p1' }, { sha: 'p2' }],
            })
        ).toEqual({
            sha: 'abc',
            parents: ['p1', 'p2'],
            url: 'https://github.com/c/abc',
        });
        expect(parseCommit({ message: 'Not Found' })).toBeNull();
        expect(parseCommit(null)).toBeNull();
    });

    describe('getSourceTag', () => {
        const pipeline = (value) => ({
            buildName: 'release-openjdk21-pipeline',
            buildParams: value ? [{ name: 'scmReference', value }] : [],
        });
        const revision = { sha: 'r2', time: 1, url: 'https://github.com/c/r2' };
        const source = { sha: 'merge13', parents: ['rel', 'ga13'] };
        const verified = {
            status: 'verified',
            relation: 'merge',
            revision,
            plannedTag: 'jdk-21.0.13-ga',
            source,
        };

        test('uses the scmReference parameter and the verification', () => {
            expect(
                getSourceTag(pipeline('jdk-21.0.13+9_adopt'), verified)
            ).toEqual({
                tag: 'jdk-21.0.13+9_adopt',
                repo: 'jdk21u',
                fromPlan: false,
                status: 'verified',
                relation: 'merge',
                revision,
                plannedTag: 'jdk-21.0.13-ga',
                commit: source,
                url: 'https://github.com/adoptium/jdk21u/releases/tag/jdk-21.0.13%2B9_adopt',
            });
        });

        test('keeps the tag when the check could not be done', () => {
            const source = getSourceTag(pipeline('jdk-21.0.99-ga'), null);
            expect(source.tag).toBe('jdk-21.0.99-ga');
            expect(source.status).toBe('unavailable');
            expect(source.revision).toBeNull();
            expect(
                getSourceTag(pipeline('jdk-21.0.99-ga'), {
                    status: 'unresolved',
                }).status
            ).toBe('unresolved');
        });

        test('falls back to the tag planned in the revision', () => {
            const planned = {
                status: 'planned',
                revision,
                plannedTag: 'jdk-21.0.13-ga',
            };
            const result = getSourceTag(pipeline(''), planned);
            expect(result.tag).toBe('jdk-21.0.13-ga');
            expect(result.fromPlan).toBe(true);
            expect(getSourceTag(pipeline(''), null)).toBeNull();
            expect(
                getSourceTag(pipeline(''), { status: 'notfound' })
            ).toBeNull();
        });
    });
});

describe('releaseNextSteps', () => {
    const platforms = [
        { key: 'x64_linux', label: 'x64 Linux', state: 'ready' },
        { key: 'x64_mac', label: 'x64 Mac', state: 'triage' },
    ];
    const done = {
        counts: { inprogress: 0, triage: 0, ready: 0 },
        platforms: [],
        installers: { expected: [] },
        linux: { status: 'published', expected: [] },
        containers: { status: 'published' },
        releaseNotes: { status: 'published' },
    };

    test('is empty when everything is published', () => {
        expect(releaseNextSteps(done)).toEqual([]);
    });

    test('lists what is left to do', () => {
        const steps = releaseNextSteps({
            ...done,
            counts: { inprogress: 2, triage: 1, ready: 1 },
            platforms,
            installers: {
                expected: [
                    { label: 'x64 Mac', published: false },
                    { label: 'x64 Windows', published: true },
                ],
            },
            linux: {
                status: 'partial',
                expected: [
                    { label: 'x64 Linux', state: 'failed' },
                    { label: 'aarch64 Linux', state: 'pending' },
                    { label: 'ppc64le Linux', state: 'published' },
                ],
            },
            containers: { status: 'pending' },
            releaseNotes: { status: 'pending' },
        });
        expect(steps).toEqual([
            'Wait for 2 platform(s) to finish building and testing',
            'Triage the failures on 1 platform(s): x64 Mac',
            'Publish the binaries for 1 platform(s): x64 Linux',
            'Publish the Windows and macOS installers for x64 Mac',
            'Investigate create_installer_linux for x64 Linux',
            'Publish the Linux packages (RPM/DEB/APK) for aarch64 Linux',
            'Publish the container images on Docker Hub',
            'Publish the release notes',
        ]);
    });

    test('asks for a manual check when a status is unavailable', () => {
        const steps = releaseNextSteps({
            ...done,
            publishedKnown: false,
            containersKnown: false,
            linux: { status: 'unavailable', expected: platforms },
            releaseNotes: null,
        });
        expect(steps).toHaveLength(3);
        expect(steps.join(' ')).toMatch(/Adoptium API/);
        expect(steps.join(' ')).toMatch(/create_installer_linux/);
        expect(steps.join(' ')).toMatch(/Docker Hub/);
    });
});
