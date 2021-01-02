import {promisify} from "util";
import {exec} from "child_process";
import inquirer from "inquirer";
import AWS from "aws-sdk";
import arnParser from "aws-arn";
import _ from "lodash/fp";
import uri from "node-uri";
import nanoid from "nanoid";
import promiseRetry from "promise-retry";
import yargs from "yargs";
import { hideBin } from "yargs/helpers"
const { execSync } = require("child_process");


const getFunctionFromTerraform = async () => {
	const filterDeepObject = (iteratee) => (root) => {
		if (Array.isArray(root)) {
			return _.flatten([...root.map(filterDeepObject(iteratee))]);
		}else if (root !== null && typeof root === "object") {
			return _.flatten([iteratee(root) ? [root] : [], ...Object.values(root).map(filterDeepObject(iteratee))]);
		}else {
			return [];
		}
	};

	const {stdout} = await promisify(exec)("terraform show -json");
	const functions = filterDeepObject((obj) => obj.type === "aws_lambda_function")(JSON.parse(stdout));
	const selectedFunction = await (async () => {
		if (functions.length === 0) {
			throw new Error("no functions are managed by Terraform");
		}else if (functions.length === 1) {
			return {"function": functions[0]};
		}else {
			return inquirer.prompt([{type: "list", name: "function", message: "Lambda function", choices: functions.map((fn) => ({name: `[${fn.address}] ${fn.values.function_name}`, value: fn}))}]);
		}
	})();
	return {
		functionName: selectedFunction.function.values.function_name,
		region: arnParser.parse(selectedFunction.function.values.arn).region,
	};
};

const getCredentials = async (roleArn) => {
	const iam = new AWS.IAM();
	const sts = new AWS.STS();

	const roleName = arnParser.parse(roleArn).resource.id;

	const role = await iam.getRole({RoleName: roleName}).promise();
	const assumeRoleDocument = JSON.parse(uri.decodeURIComponentString(role.Role.AssumeRolePolicyDocument));

	const existingStatements = _.isArray(assumeRoleDocument.Statement) ? assumeRoleDocument.Statement : [assumeRoleDocument.Statement];

	const currentArn = (await sts.getCallerIdentity({}).promise()).Arn;

	const sidId = nanoid.customAlphabet("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 10)();

	const sidPrefix = "SETLAMBDAENVTEMP";

	const newStatement = {
		Sid: `${sidPrefix}${sidId}`,
		Effect: "Allow",
		Principal: {AWS: currentArn},
		Action: "sts:AssumeRole",
		Condition: {
			DateLessThan: {
				"aws:EpochTime": Math.round(new Date().getTime() / 1000) + 10 * 60,
			},
		},
	};

	const newPolicy = {
		...assumeRoleDocument,
		Statement: [...existingStatements, newStatement],
	};

	await iam.updateAssumeRolePolicy({RoleName:roleName, PolicyDocument: JSON.stringify(newPolicy)}).promise();

	const assumedRole = await promiseRetry((retry) => sts.assumeRole({RoleArn: roleArn, RoleSessionName: "set-lambda-env-vars"}).promise().catch(retry));

	const revertedPolicy = {
		...newPolicy,
		Statement: newPolicy.Statement.filter(({Sid}) => Sid === undefined || !Sid.startsWith(sidPrefix)),
	};

	await iam.updateAssumeRolePolicy({RoleName:roleName, PolicyDocument: JSON.stringify(revertedPolicy)}).promise();

	return {
		AWS_ACCESS_KEY_ID: assumedRole.Credentials.AccessKeyId,
		AWS_SECRET_ACCESS_KEY: assumedRole.Credentials.SecretAccessKey,
		AWS_SESSION_TOKEN: assumedRole.Credentials.SessionToken,
	};
};

const getEnvVariables = async (functionName, region) => {
	const lambda = new AWS.Lambda({region});

	const fn = await lambda.getFunction({FunctionName: functionName}).promise();

	const roleArn = fn.Configuration.Role;
	const env = fn.Configuration.Environment.Variables;
	const functionRegion = arnParser.parse(fn.Configuration.FunctionArn).region;

	const credentials = await getCredentials(roleArn);

	const envVariables = {
		...credentials,
		AWS_REGION: functionRegion,
		...env,
	};

	return envVariables;
};

export const cli = async (args) => {
	const commandIsFromIndex = Array.from(args).findIndex((item, index, list) => {
		const prevItem = index > 0 ? list[index - 1] : undefined;
		return index > 1 && item !== "-f" && item !== "--function" && (prevItem === undefined || (prevItem !== "-f" && prevItem !== "--function"));
	});
	const toolArguments = Array.from(args).filter((_e, i) => i <= commandIsFromIndex);
	const command = Array.from(args).filter((_e, i) => i >= commandIsFromIndex);
	const argv = yargs(hideBin(toolArguments))
		.usage("$0 [-f|--function] <command...>", "Calls <command> with Lambda environment variables set", (yargs) => {
			yargs.option("f", {
				alias: "function",
				describe:
					"The function name or Arn",
				type: "string"
			});
		})
		.help()
		.argv;

	const functionArg = argv.function;
	const fn = await (async () => {
		if (functionArg) {
			if (functionArg.startsWith("arn:")) {
				const parsed = arnParser.parse(functionArg);
				return {
					functionName: parsed.resourcePart.replace(/^(function:)/, ""),
					region: parsed.region,
				};
			}else {
				return {functionName: functionArg};
			}
		}else {
			return getFunctionFromTerraform();
		}
	})();

	const envVariables = await getEnvVariables(fn.functionName, fn.region);

	const commandToRun = [
		..._.flow(
			_.toPairs,
			_.map(([k, v]) => {
				return `${k}=${v}`;
			}),
		)(envVariables),
		...command,
	].join(" ");

	execSync(commandToRun, { stdio: "inherit" });
};
