import type { RemovalPolicy } from "aws-cdk-lib";
import { Duration } from "aws-cdk-lib";
import { AccountRecovery, CfnUserPoolGroup, UserPool, type UserPoolClient } from "aws-cdk-lib/aws-cognito";
import { Construct } from "constructs";

export interface AuthProps {
  readonly removalPolicy: RemovalPolicy;
}

/**
 * Cognito user pool. Self sign-up is off: an admin creates users and adds them to the `organizers` or
 * `attendees` group, and the group list in the token drives authorization.
 */
export class Auth extends Construct {
  readonly userPool: UserPool;
  readonly client: UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthProps) {
    super(scope, id);

    this.userPool = new UserPool(this, "UserPool", {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      removalPolicy: props.removalPolicy,
    });

    this.client = this.userPool.addClient("ApiClient", {
      // SRP for real apps; USER_PASSWORD_AUTH only so the README can show a curl-able sign-in.
      authFlows: { userSrp: true, userPassword: true },
      generateSecret: false,
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(1),
    });

    for (const [logicalId, groupName] of [
      ["OrganizersGroup", "organizers"],
      ["AttendeesGroup", "attendees"],
    ] as const) {
      new CfnUserPoolGroup(this, logicalId, { userPoolId: this.userPool.userPoolId, groupName });
    }
  }
}
