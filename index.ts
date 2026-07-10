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

export const gcpProjectId = project.projectId;
export const gcpProjectNumber = project.number;
export const hostingSiteName = hostingSite.name;
export const hostingDefaultUrl = hostingSite.defaultUrl;
