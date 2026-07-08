import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";

const config = new pulumi.Config();
const projectId = config.require("projectId");
const githubRepo = config.require("githubRepo"); // "owner/repo" 形式

// --- 1. 必要な API を有効化 -----------------------------------------
const requiredServices = [
    "cloudresourcemanager.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "serviceusage.googleapis.com",
    "cloudbilling.googleapis.com",
    "firebase.googleapis.com",
    "firebasehosting.googleapis.com",
];

const services = requiredServices.map(
    (service) =>
        new gcp.projects.Service(service.split(".")[0], {
            project: projectId,
            service,
            disableDependentServices: false,
            disableOnDestroy: false,
        })
);

// --- 2. Workload Identity Pool ---------------------------------------
const githubPool = new gcp.iam.WorkloadIdentityPool(
    "github-actions",
    {
        project: projectId,
        workloadIdentityPoolId: "github-actions",
        displayName: "GitHub Actions",
        description: "WIF pool federating GitHub Actions OIDC tokens",
    },
    { dependsOn: services }
);

// --- 3. Workload Identity Pool Provider (OIDC) -----------------------
const githubProvider = new gcp.iam.WorkloadIdentityPoolProvider(
    "github-actions",
    {
        project: projectId,
        workloadIdentityPoolId: githubPool.workloadIdentityPoolId,
        workloadIdentityPoolProviderId: "github-actions",
        displayName: "GitHub Actions OIDC",
        attributeMapping: {
            "google.subject": "assertion.sub",
            "attribute.repository": "assertion.repository",
            "attribute.repository_owner": "assertion.repository_owner",
            "attribute.ref": "assertion.ref",
        },
        // このリポジトリ以外からの federation を許可しない
        attributeCondition: pulumi.interpolate`assertion.repository == "${githubRepo}"`,
        oidc: {
            issuerUri: "https://token.actions.githubusercontent.com",
        },
    }
);

// --- 4. GitHub Actions 用サービスアカウント ---------------------------
const deploySa = new gcp.serviceaccount.Account(
    "github-actions-deploy",
    {
        project: projectId,
        accountId: "github-actions-deploy",
        displayName: "GitHub Actions deploy (b-infra)",
    },
    { dependsOn: services }
);

// --- 5. WIF -> SA なりすまし許可（roles/iam.workloadIdentityUser） -----
// リポジトリ属性で絞り込み、他リポジトリからは this SA を騙れないようにする
const wifBinding = new gcp.serviceaccount.IAMMember("github-actions-wif", {
    serviceAccountId: deploySa.name,
    role: "roles/iam.workloadIdentityUser",
    member: pulumi.interpolate`principalSet://iam.googleapis.com/${githubPool.name}/attribute.repository/${githubRepo}`,
});

// --- 6. 本体 (index.ts) の pulumi up 実行に必要な最小限のロールを付与 ---
const deploySaRoles = [
    "roles/firebase.admin",
    "roles/browser",
    "roles/serviceusage.serviceUsageViewer",
];

deploySaRoles.forEach((role) => {
    new gcp.projects.IAMMember(`deploy-sa-${role.split("/")[1]}`, {
        project: projectId,
        role,
        member: pulumi.interpolate`serviceAccount:${deploySa.email}`,
    });
});

// --- Outputs（GitHub Actions の repository variables に設定する値） ----
export const workloadIdentityPoolProviderName = githubProvider.name;
export const deployServiceAccountEmail = deploySa.email;
export const workloadIdentityPoolName = githubPool.name;
