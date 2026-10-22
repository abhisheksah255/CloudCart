// =====================================================================
//  CloudCart — Jenkins pipeline  (Stage 1 & 2 CI/CD)
// ---------------------------------------------------------------------
//  Modelled on the TSRS production pipeline: one parameterised job that
//  builds ONE service (or all), copies the runtime .env from the Jenkins
//  server, pushes to ECR, and forces a new ECS deployment.
//
//  Runs on the Jenkins EC2 (docs/04 Step 4b). The instance role
//  cloudcart-jenkins-role gives it ECR push + ECS update rights, so no
//  AWS keys are stored in Jenkins.
//
//  Runtime config lives on the Jenkins server, outside the repo:
//      /opt/script/cloudcart/<service>/.env
//  (one file per service; see docs/04 Step 4b.3 for the exact contents)
//
//  Stage 3 replaces this with .github/workflows/deploy.yml + Secrets Manager.
// =====================================================================
pipeline {
    agent any

    parameters {
        string(name: 'BRANCH',  defaultValue: 'main', description: 'Git branch to build')
        choice(name: 'SERVICE', choices: ['auth', 'product', 'cart', 'order', 'payment', 'frontend', 'all'],
               description: 'Which service to build & deploy (all = every service)')
        booleanParam(name: 'NO_CACHE', defaultValue: false, description: 'docker build --no-cache (slower, use after dependency changes)')
    }

    environment {
        GIT_URL                = 'https://github.com/<your-github-user>/cloudcart.git'   // <-- change
        JENKINS_CREDENTIALS_ID = 'github-cloudcart'            // Jenkins → Credentials → GitHub PAT (not needed for a public repo)
        AWS_ACCOUNT_ID         = '856698935369'
        AWS_DEFAULT_REGION     = 'us-east-1'
        ECS_CLUSTER            = 'cloudcart-cluster'
        CONFIG_ROOT            = '/opt/script/cloudcart'       // runtime .env files on this server
        TIMESTAMP              = "${new Date().format('yyyyMMdd-HHmmss')}"
        IMAGE_TAG              = "${TIMESTAMP}"                // every build gets a unique tag; 'latest' is also moved
        ECR                    = "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_DEFAULT_REGION}.amazonaws.com"
    }

    stages {

        stage('Cloning Git') {
            steps {
                checkout([
                    $class: 'GitSCM',
                    branches: [[name: "*/${params.BRANCH}"]],
                    extensions: [],
                    userRemoteConfigs: [[ url: "${GIT_URL}" /*, credentialsId: "${JENKINS_CREDENTIALS_ID}" */ ]]
                ])
                script {
                    // Resolve the service list once; every later stage loops over it
                    env.SERVICES = (params.SERVICE == 'all') ? 'auth product cart order payment frontend' : params.SERVICE
                    echo "Building: ${env.SERVICES}  (branch ${params.BRANCH}, tag ${IMAGE_TAG})"
                }
            }
        }

        stage('Login to AWS ECR') {
            steps {
                sh "aws ecr get-login-password --region ${AWS_DEFAULT_REGION} | docker login --username AWS --password-stdin ${ECR}"
            }
        }

        stage('Copy Runtime Config') {
            steps {
                script {
                    for (svc in env.SERVICES.split()) {
                        if (svc == 'frontend') { continue }                 // static site, no secrets
                        def dir = "services/${svc}-service"
                        sh """
                        echo "=== ${svc}: copying ${CONFIG_ROOT}/${svc}/.env ==="
                        test -f ${CONFIG_ROOT}/${svc}/.env || { echo "❌ ${CONFIG_ROOT}/${svc}/.env missing on the Jenkins server"; exit 1; }
                        cp -f ${CONFIG_ROOT}/${svc}/.env ${dir}/.env
                        # sanity: the two shared secrets must be present (never print their values)
                        grep -q '^JWT_SECRET='             ${dir}/.env || { echo "❌ JWT_SECRET missing in ${svc}/.env"; exit 1; }
                        grep -q '^INTERNAL_SERVICE_TOKEN=' ${dir}/.env || { echo "❌ INTERNAL_SERVICE_TOKEN missing in ${svc}/.env"; exit 1; }
                        echo "✅ ${svc}/.env validated"
                        """
                    }
                }
            }
        }

        stage('Docker Build and Push') {
            steps {
                script {
                    def noCache = params.NO_CACHE ? '--no-cache' : ''
                    for (svc in env.SERVICES.split()) {
                        def ctx  = (svc == 'frontend') ? 'frontend' : "services/${svc}-service"
                        def repo = (svc == 'frontend') ? 'cloudcart/frontend' : "cloudcart/${svc}-service"
                        sh """
                        echo "=== Building ${repo}:${IMAGE_TAG} ==="
                        docker build ${noCache} -t ${ECR}/${repo}:${IMAGE_TAG} -t ${ECR}/${repo}:latest ${ctx}
                        docker push ${ECR}/${repo}:${IMAGE_TAG}
                        docker push ${ECR}/${repo}:latest
                        echo "✅ Image pushed: ${ECR}/${repo}:${IMAGE_TAG}"
                        """
                    }
                }
            }
        }

        stage('ECS Deployment') {
            steps {
                script {
                    for (svc in env.SERVICES.split()) {
                        // --task-definition with the FAMILY name only = "use the latest ACTIVE revision".
                        // (Pinning family:4 like the TSRS job silently ignores revisions created later in the console.)
                        sh """
                        aws ecs update-service --region ${AWS_DEFAULT_REGION} \\
                            --cluster ${ECS_CLUSTER} --service cc-${svc} \\
                            --task-definition cc-${svc} --force-new-deployment > /dev/null
                        echo "✅ cc-${svc}: new deployment triggered"
                        """
                    }
                }
            }
        }

        stage('Wait for stable') {
            steps {
                script {
                    def names = env.SERVICES.split().collect { "cc-${it}" }.join(' ')
                    // Blocks until every service reaches steady state (max ~10 min) so a failed deploy fails the job
                    sh "aws ecs wait services-stable --region ${AWS_DEFAULT_REGION} --cluster ${ECS_CLUSTER} --services ${names}"
                }
            }
        }

        stage('Clean Workspace') {
            steps {
                sh 'docker image prune -af --filter "until=24h" || true'   // keep disk free on the Jenkins box
                deleteDir()                                                // removes the copied .env files too
            }
        }
    }

    post {
        always  { echo 'Pipeline execution completed' }
        success { echo "✅ Deployment successful! Services: ${env.SERVICES}  Tag: ${IMAGE_TAG}" }
        failure {
            echo "❌ Pipeline failed! Check ECS at:"
            echo "https://${AWS_DEFAULT_REGION}.console.aws.amazon.com/ecs/v2/clusters/${ECS_CLUSTER}/services"
        }
    }
}
