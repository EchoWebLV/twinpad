import { OperatorForm } from "../../components/operator-form";

/** Hidden bundle page: the operator pastes the dev wallet and the buyer wallets; they fund their own buys, the pool fronts the maker. Not linked from the nav. */
export default function BundleLaunch() {
  return <OperatorForm bundle />;
}
