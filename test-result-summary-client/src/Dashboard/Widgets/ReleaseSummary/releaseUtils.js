import { getInfoFromBuildName } from '../../../utils/Utils';

// Release pipelines are generated as release-openjdk<version>-pipeline
export const PIPELINE_REGEX = /release-openjdk\d+u?-pipeline/i;

const ARCH_MAP = { 'x86-64': 'x64', 'x86-32': 'x32' };
const OS_LABELS = {
    linux: 'Linux',
    mac: 'Mac',
    windows: 'Windows',
    aix: 'AIX',
    'alpine-linux': 'alpine-Linux',
    solaris: 'Solaris',
};
// Primary platforms are prioritized in the Adoptium release status issue
const PRIMARY_PLATFORMS = new Set([
    'x64_linux',
    'x64_windows',
    'x64_mac',
    'aarch64_linux',
    'aarch64_mac',
]);

export const normalizeArch = (arch) => ARCH_MAP[arch] || arch;

// Platform key uses the Adoptium naming, e.g. x64_linux, aarch64_alpine-linux
export const platformKey = (arch, os) => `${normalizeArch(arch)}_${os}`;

/**
 * Convert a TRSS platform (e.g. x86-64_linux) to a platform key (x64_linux).
 * Returns null for variant platforms (e.g. x86-64_linux_xl).
 */
export const toPlatformKey = (platform) => {
    if (!platform) return null;
    const [arch, ...rest] = platform.split('_');
    if (!arch || rest.length !== 1) return null;
    return platformKey(arch, rest[0]);
};

export const platformLabel = (key) => {
    const [arch, os] = key.split('_');
    return `${arch} ${OS_LABELS[os] || os}`;
};

export const isPrimaryPlatform = (key) => PRIMARY_PLATFORMS.has(key);

// e.g. jdk21u-linux-x64-temurin, jdk21u-alpine-linux-aarch64-temurin,
// jdk21u-windows-x86-32-temurin_SmokeTests
const SDK_BUILD_REGEX =
    /^jdk(\d*)u?-(?:evaluation-|release-)?(?:(alpine)-)?(linux|mac|windows|aix|solaris)-(x64|x86-32|aarch64|arm|ppc64le|ppc64|s390x|riscv64|sparcv9)-([a-z0-9]+)(_smoketests)?$/i;

export const parseSdkBuildName = (buildName) => {
    const m = SDK_BUILD_REGEX.exec(buildName || '');
    if (!m) return null;
    const [, jdkVersion, alpine, os, arch, impl, smoke] = m;
    return {
        jdkVersion,
        impl: impl.toLowerCase(),
        smoke: !!smoke,
        platform: platformKey(
            arch.toLowerCase(),
            alpine ? 'alpine-linux' : os.toLowerCase()
        ),
    };
};

export const parseTestBuildName = (buildName) => {
    const info = getInfoFromBuildName(buildName || '');
    if (!info) return null;
    const key = toPlatformKey(info.platform);
    return key ? { platform: key, rerun: info.rerun } : null;
};

/**
 * Classify a TRSS build as pass, fail, inprogress or none
 */
export const buildKind = (build) => {
    if (!build) return 'none';
    if (build.status && build.status !== 'Done') return 'inprogress';
    if (!build.buildResult) return 'inprogress';
    return build.buildResult === 'SUCCESS' ? 'pass' : 'fail';
};

const newer = (a, b) => (!a || (b.timestamp || 0) > (a.timestamp || 0) ? b : a);

/**
 * Collapse test builds to one entry per test target. Parallel children
 * (_testList_N) are skipped because the parent carries the aggregated result.
 * When a _rerun build exists, its result supersedes the original.
 */
export const dedupeTestBuilds = (testBuilds = []) => {
    const byName = {};
    testBuilds.forEach((build) => {
        if (build.buildName.includes('_testList_')) return;
        const name = build.buildName.replace(/_rerun$/, '');
        const slot = name === build.buildName ? 'original' : 'rerun';
        const entry = (byName[name] = byName[name] || {});
        entry[slot] = newer(entry[slot], build);
    });
    return Object.entries(byName).map(([name, { original, rerun }]) => ({
        name,
        build: rerun || original,
        rerun: rerun || null,
    }));
};

/**
 * Build the per-platform release model.
 *
 * state is one of:
 *   published  - binaries are available from the Adoptium API
 *   triage     - JDK build, AQA or TCK has a failure
 *   inprogress - build or tests still running (or no tests yet)
 *   ready      - JDK build and all AQA passed, not yet published
 */
export const buildPlatforms = ({
    sdkBuilds = [],
    testBuilds = [],
    tckResults = [],
    published = {},
}) => {
    const platforms = {};
    const ensure = (key) => {
        if (!platforms[key]) {
            platforms[key] = {
                key,
                label: platformLabel(key),
                primary: isPrimaryPlatform(key),
                jdk: null,
                smoke: {},
                tests: [],
                tck: [],
            };
        }
        return platforms[key];
    };

    sdkBuilds.forEach((build) => {
        const parsed = parseSdkBuildName(build.buildName);
        if (!parsed) return;
        const platform = ensure(parsed.platform);
        if (parsed.smoke) {
            platform.smoke[build.buildName] = newer(
                platform.smoke[build.buildName],
                build
            );
        } else {
            platform.jdk = newer(platform.jdk, build);
        }
    });

    dedupeTestBuilds(testBuilds).forEach((test) => {
        const parsed = parseTestBuildName(test.name);
        if (parsed) ensure(parsed.platform).tests.push(test);
    });

    tckResults.forEach((result) => ensure(result.key).tck.push(result));

    const list = Object.values(platforms).map((platform) => {
        const tests = [
            ...platform.tests,
            ...Object.entries(platform.smoke).map(([name, build]) => ({
                name,
                build,
                rerun: null,
            })),
        ];
        const aqa = {
            total: tests.length,
            passed: 0,
            failed: 0,
            inProgress: 0,
            failedBuilds: [],
        };
        tests.forEach(({ name, build, rerun }) => {
            const kind = buildKind(build);
            if (kind === 'pass') aqa.passed++;
            else if (kind === 'fail') {
                aqa.failed++;
                aqa.failedBuilds.push({
                    name,
                    url: build.buildUrl,
                    result: build.buildResult,
                    rerun: !!rerun,
                });
            } else aqa.inProgress++;
        });
        aqa.failedBuilds.sort((a, b) => a.name.localeCompare(b.name));

        const tckFailed = platform.tck.filter(
            (t) => t.buildResult && t.buildResult !== 'SUCCESS'
        );
        const jdkKind = buildKind(platform.jdk);

        const reasons = [];
        if (jdkKind === 'fail') reasons.push('JDK build failed');
        if (aqa.failed) reasons.push(`${aqa.failed} AQA build(s) failed`);
        if (tckFailed.length) reasons.push(`${tckFailed.length} TCK failed`);

        let state;
        if (published[platform.key]) {
            state = 'published';
        } else if (reasons.length) {
            state = 'triage';
        } else if (
            jdkKind !== 'pass' ||
            aqa.inProgress > 0 ||
            aqa.total === 0
        ) {
            state = 'inprogress';
            if (jdkKind === 'none') reasons.push('JDK build not found');
            else if (jdkKind === 'inprogress')
                reasons.push('JDK build running');
            if (aqa.total === 0) reasons.push('No AQA builds yet');
            else if (aqa.inProgress) {
                reasons.push(`${aqa.inProgress} AQA build(s) running`);
            }
        } else {
            state = 'ready';
        }

        return {
            key: platform.key,
            label: platform.label,
            primary: platform.primary,
            state,
            reasons,
            jdk: platform.jdk,
            jdkKind,
            aqa,
            tck: platform.tck,
            tckFailed,
        };
    });

    list.sort(
        (a, b) =>
            Number(b.primary) - Number(a.primary) ||
            a.label.localeCompare(b.label)
    );
    return list;
};

export const summarizePlatforms = (platforms) => {
    const counts = {
        total: platforms.length,
        published: 0,
        ready: 0,
        triage: 0,
        inprogress: 0,
    };
    platforms.forEach((p) => counts[p.state]++);
    const pct = (n) =>
        counts.total ? Math.round((n / counts.total) * 100) : 0;
    counts.percentPublished = pct(counts.published);
    counts.percentReady = pct(counts.published + counts.ready);
    return counts;
};

/**
 * Convert an Adoptium API release (assets/release_name) to a map of
 * platform key -> { installer }
 */
export const parsePublishedPlatforms = (release) => {
    const out = {};
    ((release && release.binaries) || []).forEach((binary) => {
        if (binary.jvm_impl && binary.jvm_impl !== 'hotspot') return;
        const key = platformKey(binary.architecture, binary.os);
        out[key] = out[key] || { installer: false };
        if (binary.installer) out[key].installer = true;
    });
    return out;
};

const INSTALLER_JOB_REGEX = /(create_installer|sign_installer)/i;
export const isInstallerBuild = (buildName) =>
    INSTALLER_JOB_REGEX.test(buildName || '');

const INSTALLER_OS = new Set(['windows', 'mac']);

/**
 * Installer status. Windows MSI and macOS PKG are the installers that the
 * Adoptium API reports, so published state is derived for those platforms.
 * Installer jobs triggered by the pipeline are summarized by job name.
 */
export const summarizeInstallers = ({
    installerBuilds = [],
    platforms = [],
    published = {},
}) => {
    const jobs = {};
    installerBuilds.forEach((build) => {
        const job = (jobs[build.buildName] = jobs[build.buildName] || {
            name: build.buildName,
            total: 0,
            passed: 0,
            failed: 0,
            inProgress: 0,
            url: build.buildUrl,
        });
        job.total++;
        const kind = buildKind(build);
        if (kind === 'pass') job.passed++;
        else if (kind === 'fail') job.failed++;
        else job.inProgress++;
    });

    const expected = platforms
        .filter((p) => INSTALLER_OS.has(p.key.split('_')[1]))
        .map((p) => ({
            key: p.key,
            label: p.label,
            published: !!(published[p.key] && published[p.key].installer),
        }));
    const done = expected.filter((p) => p.published).length;

    let status = 'pending';
    if (expected.length === 0) status = 'na';
    else if (done === expected.length) status = 'published';
    else if (done > 0) status = 'partial';

    return {
        status,
        expected,
        jobs: Object.values(jobs).sort((a, b) => a.name.localeCompare(b.name)),
    };
};

/**
 * Container status from Docker Hub tags (eclipse-temurin official image)
 */
export const summarizeContainers = (version, tags = []) => {
    const matching = version
        ? tags.filter((t) => t.name.startsWith(`${version}-`))
        : [];
    const platforms = [...new Set(matching.flatMap((t) => t.platforms || []))];
    return {
        status: matching.length ? 'published' : 'pending',
        tags: matching.map((t) => t.name).sort(),
        platforms: platforms.sort(),
    };
};

/**
 * Release tag helpers
 */
const RELEASE_NAME_REGEX = /^(jdk-\d+(\.\d+)*\+\d+|jdk\d+u\d+-b\d+)$/;

// jdk-21.0.5+11_adopt -> jdk-21.0.5+11. Returns null if not a build tag
// (e.g. jdk-21.0.5-ga does not identify the published build)
export const normalizeReleaseName = (ref) => {
    if (!ref) return null;
    const name = String(ref)
        .trim()
        .replace(/_adopt$/, '');
    return RELEASE_NAME_REGEX.test(name) ? name : null;
};

// "(build 21.0.5+11-LTS)" -> jdk-21.0.5+11, "(build 1.8.0_432-b06)" -> jdk8u432-b06
export const releaseNameFromJavaVersion = (javaVersion) => {
    if (!javaVersion) return null;
    let m = /\(build 1\.8\.0_(\d+)-b(\d+)\)/.exec(javaVersion);
    if (m) return `jdk8u${m[1]}-b${m[2]}`;
    m = /\(build (\d+(?:\.\d+)*)\+(\d+)/.exec(javaVersion);
    if (m) return `jdk-${m[1]}+${m[2]}`;
    return null;
};

const PUBLISH_PARAMS = ['overridePublishName', 'scmReference', 'publishName'];

const paramValue = (build, name) => {
    const param = ((build && build.buildParams) || []).find(
        (p) => p.name === name
    );
    return param ? param.value : null;
};

export const getReleaseName = (parent, childBuilds = []) => {
    const builds = [parent, ...childBuilds];
    for (const name of PUBLISH_PARAMS) {
        for (const build of builds) {
            const releaseName = normalizeReleaseName(paramValue(build, name));
            if (releaseName) return releaseName;
        }
    }
    for (const build of builds) {
        const releaseName = releaseNameFromJavaVersion(
            build && build.javaVersion
        );
        if (releaseName) return releaseName;
    }
    return null;
};

// jdk-21.0.5+11 -> 21.0.5_11, jdk8u432-b06 -> 8u432-b06
export const dockerVersionTag = (releaseName) => {
    if (!releaseName) return null;
    return releaseName
        .replace(/^jdk-/, '')
        .replace(/^jdk(?=\d+u)/, '')
        .replace('+', '_');
};

export const releaseNotesWebUrl = (releaseName) =>
    releaseName
        ? `https://adoptium.net/temurin/release-notes?version=${encodeURIComponent(
              releaseName
          )}`
        : null;

/**
 * Convert an Adoptium API release notes response (info/release_notes) to a
 * summary. The notes are considered published when the API returns at least
 * one entry; a 404 (handled by the caller) means they are not published yet.
 */
export const summarizeReleaseNotes = (releaseName, response) => {
    const notes = (response && response.release_notes) || [];
    return {
        status: notes.length ? 'published' : 'pending',
        count: notes.length,
        url: releaseNotesWebUrl(releaseName),
    };
};
