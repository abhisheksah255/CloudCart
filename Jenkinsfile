// CloudCart — Jenkins pipeline (Stage 2, Step 9 Option B)
// Runs on a Jenkins EC2 instance whose IAM instance role can push to ECR and update ECS.
pipeline {
    agent any
    environment {
        AWS_REGION     = 'ap-south-1'
        ECS_CLUSTER    = 'cloudcart-cluster'
        AWS_ACCOUNT_ID = sh(script: 'aws sts get-caller-identity --query Account --output text', returnStdout: true).trim()
        ECR            = "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
        TAG            = "v${env.BUILD_NUMBER}"
    }
    stages {
        stage('Login to ECR') {
            steps { sh 'aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR' }
        }
        stage('Build & push services') {
            steps {
                script {
                    for (svc in ['auth', 'product', 'cart', 'order', 'payment']) {
                        sh "docker build -t $ECR/cloudcart/${svc}-service:$TAG -t $ECR/cloudcart/${svc}-service:latest services/${svc}-service"
                        sh "docker push $ECR/cloudcart/${svc}-service --all-tags"
                    }
                    sh "docker build -t $ECR/cloudcart/frontend:$TAG -t $ECR/cloudcart/frontend:latest frontend"
                    sh "docker push $ECR/cloudcart/frontend --all-tags"
                }
            }
        }
        stage('Deploy to ECS') {
            steps {
                script {
                    for (svc in ['auth', 'product', 'cart', 'order', 'payment', 'frontend']) {
                        sh "aws ecs update-service --cluster $ECS_CLUSTER --service cc-${svc} --force-new-deployment --region $AWS_REGION > /dev/null"
                    }
                }
            }
        }
    }
    post {
        always  { sh 'docker image prune -af || true' }
        success { echo "✅ Deployed ${TAG}" }
        failure { echo "❌ Build failed — check the stage logs above" }
    }
}
