import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import ReleaseSummary from './ReleaseSummary';

// Jest 27 (CRA) cannot resolve react-router's package exports map
jest.mock(
    'react-router-dom',
    () => ({ Link: ({ children }) => <a>{children}</a> }),
    {
        virtual: true,
    }
);
jest.mock('../../../utils/Utils', () => ({
    ...jest.requireActual('../../../utils/Utils'),
    fetchData: jest.fn(),
}));
const { fetchData } = require('../../../utils/Utils');

const b = (buildName, buildResult = 'SUCCESS', extra = {}) => ({
    _id: buildName,
    buildName,
    buildResult,
    status: 'Done',
    buildNum: 1,
    buildUrl: `http://jenkins/${buildName}`,
    timestamp: 1,
    ...extra,
});

const T = (p, r) => b(`Test_openjdk21_hs_sanity.functional_${p}`, r);

const routes = {
    '/api/getTopLevelBuildNames?type=Build': [
        { _id: { url: 'http://j', buildName: 'release-openjdk21-pipeline' } },
        { _id: { url: 'http://j', buildName: 'openjdk21-pipeline' } },
    ],
    '/api/getTopLevelBuildNames?type=Test': [],
    '/api/getBuildHistory': [
        b('release-openjdk21-pipeline', 'SUCCESS', { _id: 'p1', buildNum: 7 }),
    ],
    '/api/getData': [
        b('release-openjdk21-pipeline', 'SUCCESS', {
            _id: 'p1',
            buildNum: 7,
            buildParams: [
                { name: 'overridePublishName', value: 'jdk-21.0.5+11' },
            ],
        }),
    ],
    '^(jdk[0-9]{1,2}|jdk-|Build_)': [
        b('jdk21u-linux-x64-temurin'),
        b('jdk21u-mac-x64-temurin'),
        b('jdk21u-linux-aarch64-temurin'),
    ],
    '^(Test|Perf)_openjdk.*': [
        T('x86-64_linux'),
        T('x86-64_mac'),
        T('aarch64_linux', 'FAILURE'),
    ],
    '(create_installer|sign_installer)': [b('create_installer_mac')],
    '^AQA_Test_Pipeline_JCK$': [],
    '/api/getLinuxInstallerBuilds?tag=jdk-21.0.5+11': {
        builds: [
            b('create_installer_linux', 'SUCCESS', {
                buildNum: 3,
                buildParams: [
                    { name: 'TAG', value: 'jdk-21.0.5+11' },
                    {
                        name: 'ARTIFACTS_TO_COPY',
                        value: 'build/linux/x64/jdk/hotspot/*.tar.gz',
                    },
                ],
            }),
        ],
    },
    '/api/getDockerTags': {
        count: 1,
        tags: [{ name: '21.0.5_11-jdk-noble', platforms: ['linux/amd64'] }],
    },
};

let notesResponse;

beforeEach(() => {
    notesResponse = {
        status: 200,
        ok: true,
        json: async () => ({ release_notes: [{ id: 'JDK-1' }] }),
    };
    global.IS_REACT_ACT_ENVIRONMENT = true;
    fetchData.mockImplementation(async (url) => {
        const key = Object.keys(routes).find((k) =>
            decodeURIComponent(url).includes(k)
        );
        return key ? routes[key] : [];
    });
    global.fetch = jest.fn(async (url) => {
        if (url.includes('/info/release_notes/')) {
            return notesResponse;
        }
        return {
            status: 200,
            ok: true,
            json: async () => ({
                binaries: [
                    { architecture: 'x64', os: 'linux', jvm_impl: 'hotspot' },
                    {
                        architecture: 'x64',
                        os: 'mac',
                        jvm_impl: 'hotspot',
                        installer: {},
                    },
                ],
            }),
        };
    });
});

const flush = () => act(() => new Promise((r) => setTimeout(r, 20)));

test('renders summary for the selected pipeline', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = jest.fn();

    await act(async () => {
        root.render(
            <ReleaseSummary
                pipelineSelected="p1"
                pipelineLabel="release-openjdk21-pipeline #7"
                onChange={onChange}
            />
        );
    });
    await flush();
    await flush();

    const text = container.textContent;
    expect(text).toContain('Release: jdk-21.0.5+11');
    expect(text).toContain('Platforms Published (2)');
    const order = [
        'Platforms In Progress',
        'Platforms Requiring Triage',
        'Platforms Ready to Publish',
        'Platforms Published',
    ].map((h) => text.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain('Release Notes');
    expect(text).toContain('1 item(s)');
    expect(
        container.querySelector(
            'a[href*="release-notes?version=jdk-21.0.5%2B11"]'
        )
    ).not.toBeNull();
    expect(text).toContain('Platforms Ready to Publish (0)');
    expect(text).toContain('Platforms Requiring Triage (1)');
    expect(text).toContain('67% published');
    expect(text).toContain('Installers');
    expect(text).toContain('Containers');
    expect(text).toContain('linux/amd64');
    expect(text).toContain('Linux packages (RPM / DEB / APK)');
    expect(
        container.querySelector(
            'a[href="http://jenkins/create_installer_linux"]'
        ).textContent
    ).toBe('x64 Linux');
    // pipeline dropdown only lists release pipelines
    expect(
        fetchData.mock.calls.some(([u]) => u.includes('getBuildHistory'))
    ).toBe(true);

    await act(async () => root.unmount());
});

test('reports release notes as not published on 404', async () => {
    notesResponse = { status: 404, ok: false, json: async () => ({}) };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(
            <ReleaseSummary pipelineSelected="p1" onChange={jest.fn()} />
        );
    });
    await flush();
    await flush();
    const text = container.textContent;
    expect(text).toMatch(/Release Notes\s*Not published/);
    await act(async () => root.unmount());
});

test('shows a prompt when nothing is selected', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(<ReleaseSummary onChange={jest.fn()} />);
    });
    await flush();
    expect(container.textContent).toContain(
        'Select a release pipeline to see its summary'
    );
    await act(async () => root.unmount());
});
