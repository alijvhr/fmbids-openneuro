import React from "react"

export const OrcidEmailWarning = () => (
  <div className="panel-heading">
    <h2>No Email Provided</h2>
    <p>
      To make contributions to fmbids-openneuro, please provide a contact email
      address.
    </p>
    <p>
      Verify an email and make it available either publicly or to trusted
      institutions to make contributions to fmbids-openneuro. See our{" "}
      <a href="https://docs.openneuro.org/orcid.html#enabling-trusted-access-to-emails">
        ORCID documentation
      </a>{" "}
      for detailed instructions.
    </p>
  </div>
)

export default OrcidEmailWarning
