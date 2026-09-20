import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";

const config = new pulumi.Config();
const projectId = config.require("projectId");
const githubRepo = config.require("githubRepo"); // "owner/repo" 形式（表示・可読性のため）
// repository は owner/repo 名の変更・アカウント名の再利用（repojacking）に弱いため、
// 不変の数値ID（`gh api repos/<owner>/<repo> --jq .id`で取得）も条件に加える。
const githubRepoId = config.require("githubRepoId");

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
    "firestore.googleapis.com",
    "firebaserules.googleapis.com",
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
            "attribute.repository_id": "assertion.repository_id",
            "attribute.repository_owner": "assertion.repository_owner",
            "attribute.ref": "assertion.ref",
        },
        // このリポジトリ以外からの federation を許可しない。
        // repository（名前）だけでなく repository_id（不変・再利用不可のID）も必須にすることで、
        // リポジトリ名やGitHubアカウント名が将来変更・解放された後に第三者が同名を取得しても
        // なりすませないようにする。
        attributeCondition: pulumi.interpolate`assertion.repository == "${githubRepo}" && assertion.repository_id == "${githubRepoId}"`,
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
// repository_id（不変ID）で絞り込み、他リポジトリ・リポジトリ名の乗っ取りからも
// this SA を騙れないようにする
const wifBinding = new gcp.serviceaccount.IAMMember("github-actions-wif", {
    serviceAccountId: deploySa.name,
    role: "roles/iam.workloadIdentityUser",
    member: pulumi.interpolate`principalSet://iam.googleapis.com/${githubPool.name}/attribute.repository_id/${githubRepoId}`,
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

// --- 7. b-web（別リポジトリ）専用の追加リソース --------------------------
// b-web は Pulumi を使わず、GitHub Actions 上で firebase-tools CLI から
// `firebase deploy --only hosting` を直接実行する。github-actions-deploy
// (本体 pulumi up 用) とは Provider/SA を使い回さず、ブラスト半径を分離する。
const bWebGithubRepo = config.require("bWebGithubRepo");
const bWebGithubRepoId = config.require("bWebGithubRepoId");

// --- 7-1. Workload Identity Pool Provider（既存 Pool を再利用） -----------
const bWebGithubProvider = new gcp.iam.WorkloadIdentityPoolProvider(
    "github-actions-b-web",
    {
        project: projectId,
        workloadIdentityPoolId: githubPool.workloadIdentityPoolId,
        workloadIdentityPoolProviderId: "github-actions-b-web",
        displayName: "b-web GitHub Actions OIDC",
        attributeMapping: {
            "google.subject": "assertion.sub",
            "attribute.repository": "assertion.repository",
            "attribute.repository_id": "assertion.repository_id",
            "attribute.repository_owner": "assertion.repository_owner",
            "attribute.ref": "assertion.ref",
        },
        attributeCondition: pulumi.interpolate`assertion.repository == "${bWebGithubRepo}" && assertion.repository_id == "${bWebGithubRepoId}"`,
        oidc: {
            issuerUri: "https://token.actions.githubusercontent.com",
        },
    }
);

// --- 7-2. b-web 専用デプロイ用サービスアカウント --------------------------
const bWebDeploySa = new gcp.serviceaccount.Account(
    "github-actions-b-web-deploy",
    {
        project: projectId,
        accountId: "github-actions-b-web-deploy",
        displayName: "GitHub Actions deploy (b-web)",
    },
    { dependsOn: services }
);

// --- 7-3. WIF -> SA なりすまし許可（roles/iam.workloadIdentityUser） -------
const bWebWifBinding = new gcp.serviceaccount.IAMMember("b-web-github-actions-wif", {
    serviceAccountId: bWebDeploySa.name,
    role: "roles/iam.workloadIdentityUser",
    member: pulumi.interpolate`principalSet://iam.googleapis.com/${githubPool.name}/attribute.repository_id/${bWebGithubRepoId}`,
});

// --- 7-4. `firebase deploy --only hosting` 実行に必要な最小ロールを付与 ----
// roles/firebasehosting.admin は sites.create/sites.delete も含み過剰なため、
// sites.get/sites.update のみのカスタムロールを新設する（セキュリティレビュー対応）。
const bWebHostingDeployerRole = new gcp.projects.IAMCustomRole("b-web-hosting-deployer", {
    project: projectId,
    roleId: "bWebHostingDeployer",
    title: "b-web Hosting Deployer",
    description:
        "firebase deploy --only hosting に必要な最小権限（既存サイトへのデプロイのみ、sites.create/deleteを含まない）",
    permissions: [
        "firebasehosting.sites.get",
        "firebasehosting.sites.update",
        "firebase.projects.get",
        "resourcemanager.projects.get",
        // 実際にデプロイを試した際、versions作成APIが403ではなく500で失敗する事象を確認。
        // roles/firebasehosting.adminとの差分にある読み取り専用権限
        // (sites.create/deleteのような破壊的権限ではない)が不足していたことが原因の
        // 可能性が高いため追加。resourcemanager.projects.listはカスタムロールでは
        // 無効な権限(Error 400)だったため除外。
        "firebase.clients.get",
        "firebase.clients.list",
        "firebasehosting.sites.list",
    ],
});

new gcp.projects.IAMMember("b-web-deploy-sa-hosting-deployer", {
    project: projectId,
    role: bWebHostingDeployerRole.name,
    member: pulumi.interpolate`serviceAccount:${bWebDeploySa.email}`,
});

new gcp.projects.IAMMember("b-web-deploy-sa-apikeys-viewer", {
    project: projectId,
    role: "roles/serviceusage.apiKeysViewer",
    member: pulumi.interpolate`serviceAccount:${bWebDeploySa.email}`,
});

// firebase-tools が Hosting API をこのプロジェクトのクォータで呼び出すために必要。
// これがないと firebasehosting.sites.update 権限を持っていても
// `POST .../versions` が(403ではなく)500 Internal errorで失敗する事象を
// 実際のデプロイで確認したため追加（bootstrap実装時点で想定していたリスクが顕在化）。
new gcp.projects.IAMMember("b-web-deploy-sa-serviceusage-consumer", {
    project: projectId,
    role: "roles/serviceusage.serviceUsageConsumer",
    member: pulumi.interpolate`serviceAccount:${bWebDeploySa.email}`,
});

// --- 8. b-content（別リポジトリ）専用の追加リソース ------------------------
// b-content は記事コンテンツ用リポジトリ。main への直接pushで運用し、
// Firestoreへの同期はworkflow_dispatch（手動トリガー）限定で実行する。
// b-web用と同様、Provider/SAを使い回さずブラスト半径を分離する。
const bContentGithubRepo = config.require("bContentGithubRepo");
const bContentGithubRepoId = config.require("bContentGithubRepoId");

// --- 8-1. Workload Identity Pool Provider（既存 Pool を再利用） -----------
const bContentGithubProvider = new gcp.iam.WorkloadIdentityPoolProvider(
    "github-actions-b-content",
    {
        project: projectId,
        workloadIdentityPoolId: githubPool.workloadIdentityPoolId,
        workloadIdentityPoolProviderId: "github-actions-b-content",
        displayName: "b-content GitHub Actions OIDC",
        attributeMapping: {
            "google.subject": "assertion.sub",
            "attribute.repository": "assertion.repository",
            "attribute.repository_id": "assertion.repository_id",
            "attribute.repository_owner": "assertion.repository_owner",
            "attribute.ref": "assertion.ref",
        },
        attributeCondition: pulumi.interpolate`assertion.repository == "${bContentGithubRepo}" && assertion.repository_id == "${bContentGithubRepoId}"`,
        oidc: {
            issuerUri: "https://token.actions.githubusercontent.com",
        },
    }
);

// --- 8-2. b-content 専用デプロイ用サービスアカウント ------------------------
const bContentDeploySa = new gcp.serviceaccount.Account(
    "github-actions-b-content-deploy",
    {
        project: projectId,
        // GCPのサービスアカウントaccountIdは6〜30文字制限があり、
        // "github-actions-b-content-deploy"(31文字)は超過するため、
        // "b-content"のハイフンを詰めて30文字ちょうどに収める。
        accountId: "github-actions-bcontent-deploy",
        displayName: "GitHub Actions deploy (b-content)",
    },
    { dependsOn: services }
);

// --- 8-3. WIF -> SA なりすまし許可（roles/iam.workloadIdentityUser） -------
const bContentWifBinding = new gcp.serviceaccount.IAMMember("b-content-github-actions-wif", {
    serviceAccountId: bContentDeploySa.name,
    role: "roles/iam.workloadIdentityUser",
    member: pulumi.interpolate`principalSet://iam.googleapis.com/${githubPool.name}/attribute.repository_id/${bContentGithubRepoId}`,
});

// --- 8-4. Firestoreへのドキュメント書き込みに必要な最小ロールを付与 ----------
// roles/datastore.user は「ドキュメントの読み書き」のみを許可し、データベース自体の
// 作成/削除・セキュリティルール変更・インデックス管理のような破壊的操作
// （roles/datastore.owner側）は含まない。Firestoreのデータプレーン権限は
// IAM上これ以上細かく分割できないため、b-webのケース（firebasehosting.admin相当の
// 過剰権限をカスタムロールで絞った）とは異なり、追加のカスタムロール新設は不要と判断。
new gcp.projects.IAMMember("b-content-deploy-sa-datastore-user", {
    project: projectId,
    role: "roles/datastore.user",
    member: pulumi.interpolate`serviceAccount:${bContentDeploySa.email}`,
});

// --- Outputs（GitHub Actions の repository variables に設定する値） ----
export const workloadIdentityPoolProviderName = githubProvider.name;
export const deployServiceAccountEmail = deploySa.email;
export const workloadIdentityPoolName = githubPool.name;
export const bWebWorkloadIdentityPoolProviderName = bWebGithubProvider.name;
export const bWebDeployServiceAccountEmail = bWebDeploySa.email;
export const bContentWorkloadIdentityPoolProviderName = bContentGithubProvider.name;
export const bContentDeployServiceAccountEmail = bContentDeploySa.email;
