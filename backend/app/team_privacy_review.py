"""D134 bounded retry review; parent hosted log facts inherited unchanged.

New retry-table hosted catalog is a Root migration/readback prerequisite.
Runtime requires its exact catalog on the same private connection.
"""
REVIEWED_LOG_PROFILE = {'schema': 'team-private-log-reviewed-v1', 'serverLogEvidenceSHA256': '8a85cd564460d145f9840fd843a869e726bc7fb8375b76067a089efffb7a71d6', 'catalogEvidenceSHA256': 'dc539e850d0153d032332dc5f167044d7447f66afd42b406fb35bfb8c6546491', 'sourceScopeSHA256': '5b9906630179a922525247876773749177016061186ebb0a9afd2266b819d67a', 'serverVersion': '170011', 'role': 'postgres', 'sessionRole': 'postgres', 'databaseOID': '5', 'destinations': ('csvlog',), 'functionFingerprint': 'e60da680418e47f0b7d3205aea59bff8', 'ordinaryErrorVerdict': 'PASS_23505_CONTROL_DETAIL_AND_PROTECTED_ABSENCE', 'allDestinationsCovered': True, 'fatalScopeReview': 'FIXED_SQL_NO_UNREVIEWED_RAISE_OR_CONTEXT', 'reviewedAtUTC': '2026-10-18T05:10:03Z'}
