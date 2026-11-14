import { readFile, writeFile } from 'node:fs/promises';

// Wires Firebase Cloud Messaging into the generated Capacitor Android
// project. Requires android/app/google-services.json (downloaded from
// Firebase Console → Project settings → Android app). When the file is
// absent the script leaves Gradle untouched so debug builds still work —
// push simply stays disabled until the file is provided.
const jsonPath = 'android/app/google-services.json';
const projectGradlePath = 'android/build.gradle';
const appGradlePath = 'android/app/build.gradle';
const CLASSPATH = "classpath 'com.google.gms:google-services:4.4.2'";
const APPLY_PLUGIN = "apply plugin: 'com.google.gms.google-services'";

let hasConfig = false;
try {
  const json = JSON.parse(await readFile(jsonPath, 'utf8'));
  hasConfig = json.project_info?.project_id === 'veyra-34b8f';
  if (!hasConfig) {
    console.warn(`Warning: ${jsonPath} is for project "${json.project_info?.project_id}", expected "veyra-34b8f". Skipping FCM setup.`);
  }
} catch {
  console.log(`No ${jsonPath} found — skipping FCM Gradle setup (push notifications stay disabled).`);
}

if (!hasConfig) process.exit(0);

const changes = [];

const projectGradle = await readFile(projectGradlePath, 'utf8');
if (!projectGradle.includes('com.google.gms:google-services')) {
  const anchor = projectGradle.match(/classpath 'com\.android\.tools\.build:gradle:[^']+'/);
  if (!anchor) throw new Error(`Could not find Android Gradle plugin classpath in ${projectGradlePath}.`);
  await writeFile(projectGradlePath, projectGradle.replace(anchor[0], `${anchor[0]}\n        ${CLASSPATH}`));
  changes.push('project classpath');
}

const appGradle = await readFile(appGradlePath, 'utf8');
if (!appGradle.includes('com.google.gms.google-services')) {
  await writeFile(appGradlePath, `${appGradle.trimEnd()}\n\n${APPLY_PLUGIN}\n`);
  changes.push('app plugin');
}

console.log(changes.length ? `FCM wired into Gradle: ${changes.join(', ')}.` : 'FCM Gradle config already present.');
