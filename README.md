# Set a live Lambda function's environment variables locally

Replicate the environment variables of a Lambda function deployed to an AWS account. Helps with development as you can use the same resources and permissions as the function.

Supports:

* AWS_REGION
* AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN (it assumes the execution role of the function)
* all the variables set to the Lambda function

## Usage

```npx set-lambda-env-vars [-f|--function] <command>```

If no argument is provided it tries to use Terraform to find managed functions. If there are multiple, it offers a choice which one to watch.

Both function name (in the current region, defined in the AWS_REGION environment variable) or function Arn is supported for the ```-f``` argument.

Example usage that starts a new bash session with the variables:

```npx set-lambda-env-vars bash```

Using this shell you can run other commands.
