#!/usr/bin/env node

const jwt = require('jsonwebtoken');
const github = require('@octokit/rest')();
const fs = require('fs');

const {execSync} = require('child_process');
const parseDiff = require('parse-diff');

const head = process.env['CIRCLE_SHA1'];
const mergeBase = process.env['CIRCLE_MERGE_BASE'];
if (!mergeBase) {
    console.log('No merge base available.');
    return;
}

let annotations = [];
parseDiff(execSync(`git diff ${mergeBase} ${head} --unified=0 --dst-prefix='' *.cpp *.hpp`).toString()).forEach(file => {
    // Can't use git diff's exclude syntax just yet because Circle CI's git is too old.
    if (/^vendor\//.test(file.to)) {
        return;
    }

    const formatted = execSync([
        '${CLANG_FORMAT:-clang-format}',
        file.chunks
            .filter(chunk => chunk.newLines)
            .map(chunk => `-lines=${chunk.newStart}:${chunk.newStart + chunk.newLines - 1}`)
            .join(' '),
        file.to
    ].join(' ')).toString();

    // diff exits with code 1 if the files differ, and code 2 if something went wrong.
    parseDiff(execSync(`diff --unified=0 ${file.to} - || [ $? -eq 1 ]`, { input: formatted }).toString()).forEach(diff => {
        diff.chunks.forEach(function (chunk) {
            const start = chunk.oldStart;
            const end = chunk.oldStart + (chunk.oldLines ? chunk.oldLines - 1 : 0);
            annotations.push({
                path: file.to,
                start_line: start,
                end_line: end,
                annotation_level: 'notice',
                title: `consider adjusting the code formatting on line ${start}${chunk.oldLines ? `-${end}` : ''}:`,
                message: chunk.changes.map(change => change.content).join('\n')
            });
        });
    });
});

const SIZE_CHECK_APP_ID = 14028;
const SIZE_CHECK_APP_INSTALLATION_ID = 229425;

process.on('unhandledRejection', error => {
    console.log(error);
    process.exit(1)
});

const pk = process.env['SIZE_CHECK_APP_PRIVATE_KEY'];
if (!pk) {
    console.log('Fork PR; not formatting code.');
    process.exit(0);
}

const key = Buffer.from(pk, 'base64').toString('binary');
const payload = {
    exp: Math.floor(Date.now() / 1000) + 60,
    iat: Math.floor(Date.now() / 1000),
    iss: SIZE_CHECK_APP_ID
};

const token = jwt.sign(payload, key, {algorithm: 'RS256'});
github.authenticate({type: 'app', token});

github.apps.createInstallationToken({installation_id: SIZE_CHECK_APP_INSTALLATION_ID})
    .then(({data}) => {
        github.authenticate({type: 'token', token: data.token});
        return github.checks.create({
            owner: 'mapbox',
            repo: 'mapbox-gl-native',
            name: 'Code Formatting',
            head_branch: process.env['CIRCLE_BRANCH'],
            head_sha: process.env['CIRCLE_SHA1'],
            status: 'completed',
            conclusion: 'neutral',
            completed_at: new Date().toISOString(),
            output: {
                title: 'Code Formatting',
                summary: 'Proposed code formatting changes',
                annotations: annotations
            }
        });
    });
