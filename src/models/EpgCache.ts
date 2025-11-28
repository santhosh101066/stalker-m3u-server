import {
    Table,
    Column,
    Model,
    DataType,
    PrimaryKey,
    AutoIncrement,
    Index,
} from "sequelize-typescript";

@Table({
    tableName: "epg_cache",
    timestamps: true,
})
export class EpgCache extends Model {
    @PrimaryKey
    @AutoIncrement
    @Column(DataType.INTEGER)
    id!: number;

    @Column(DataType.DATE)
    timestamp!: Date;

    @Column(DataType.TEXT)
    data!: string; // JSON stringified EPG data

    @Index
    @Column(DataType.INTEGER)
    profileId?: number;
}
