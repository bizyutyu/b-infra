import * as fs from "fs";
import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";

const config = new pulumi.Config();
const projectId = config.require("projectId");
const projectDisplayName = config.get("projectDisplayName") ?? projectId;
const billingAccountId = config.requireSecret("billingAccountId");
const hostingSiteId = config.get("hostingSiteId") ?? projectId;

// GCP プロジェクトそのものは bootstrap 前段の `gcloud projects create` /
// `gcloud billing projects link` で既に存在している。ここでは Pulumi の
// state に取り込む（import）ことで、以後はこのスタックが正式なオーナーになる。
const project = new gcp.organizations.Project(
    "main",
    {
        projectId,
        name: projectDisplayName,
        billingAccount: billingAccountId,
        labels: { managed_by: "pulumi" },
        autoCreateNetwork: true,
        deletionPolicy: "PREVENT",
    },
    {
        protect: true,
    }
);

// Firebase をプロジェクト上で有効化
const firebaseProject = new gcp.firebase.Project("default", {
    project: project.projectId,
});

// Firebase Hosting サイトを作成
const hostingSite = new gcp.firebase.HostingSite(
    "default",
    {
        project: project.projectId,
        siteId: hostingSiteId,
    },
    { dependsOn: [firebaseProject] }
);

// Firestore（Native mode）データベースを作成。b-content から記事データを同期する。
// 記事データという実データを保持するため、Projectリソースと同様に誤削除を防ぐ設定を入れる。
const firestoreDatabase = new gcp.firestore.Database(
    "default",
    {
        project: project.projectId,
        name: "(default)",
        locationId: "asia-northeast1",
        type: "FIRESTORE_NATIVE",
        deleteProtectionState: "DELETE_PROTECTION_ENABLED",
        deletionPolicy: "PREVENT",
    },
    { dependsOn: [project] }
);

// Firestore Security Rules: articlesコレクションのみ公開読み取りを許可し、
// 書き込みは常に拒否する（CIからの書き込みはAdmin SDK経由でIAMにより制御され、
// Security Rulesをバイパスするため影響を受けない）。
const firestoreRuleset = new gcp.firebaserules.Ruleset(
    "firestore",
    {
        project: project.projectId,
        source: {
            files: [
                {
                    name: "firestore.rules",
                    content: fs.readFileSync("firestore.rules", "utf-8"),
                },
            ],
        },
    },
    { dependsOn: [firestoreDatabase] }
);

const firestoreRulesRelease = new gcp.firebaserules.Release(
    "firestore",
    {
        project: project.projectId,
        name: "cloud.firestore",
        rulesetName: pulumi.interpolate`projects/${project.projectId}/rulesets/${firestoreRuleset.name}`,
    },
    { dependsOn: [firestoreRuleset] }
);

export const gcpProjectId = project.projectId;
export const gcpProjectNumber = project.number;
export const hostingSiteName = hostingSite.name;
export const hostingDefaultUrl = hostingSite.defaultUrl;
export const firestoreDatabaseName = firestoreDatabase.name;
